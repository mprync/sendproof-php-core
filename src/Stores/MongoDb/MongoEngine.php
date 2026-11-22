<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use MongoDB\BSON\Document;
use MongoDB\Driver\Command;
use MongoDB\Driver\Exception\ServerException;
use MongoDB\Driver\Manager;
use MongoDB\Driver\Monitoring\CommandFailedEvent;
use MongoDB\Driver\Monitoring\CommandStartedEvent;
use MongoDB\Driver\Monitoring\CommandSucceededEvent;
use MongoDB\Driver\ReadConcern;
use MongoDB\Driver\Session;
use MongoDB\Driver\WriteConcern;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\Classifier;
use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\PreviewTransactionControlException;

/**
 * The per-client engine shared by the guarded handles and the Laravel provider:
 *
 * - **Topology**: `hello` decides the mode. A replica set or mongos with logical sessions runs in
 *   `preview` mode; anything else in `guard` mode (spec/data-stores.md "Starting the transaction").
 * - **Session**: each `preview`-mode Preview gets one client session with a snapshot/majority
 *   transaction. The handler's own `startSession()` returns a shell whose commands join it, so its
 *   `commitTransaction` and `abortTransaction` never reach the server; a raw `commitTransaction`
 *   command is refused before it is sent, or fails the Preview with 500 when it got through.
 * - **Guard**: {@see check()} classifies a command before the hook sends it.
 * - **Monitoring** (the tripwire): every command the client sends is seen. A write during a
 *   Preview without the Preview's `lsid` and `autocommit: false` fails the Preview with 500, a
 *   reply with code 263 blocks it, and every other command becomes a `Db` log entry. Candidate
 *   document ids for change capture come from the same events.
 * - **Finish**: after the handler, changes are read (inside the transaction for `after`, and at the
 *   transaction's own snapshot time for `before`), then the transaction is aborted and the session
 *   ended. A Preview that outlives its time limit is aborted and answers 500. An abort the server
 *   never acknowledged (the connection dropped) answers 500 at once, and once the response is out
 *   the session is ended with `killSessions` ({@see endLostTransactions()}), so the transaction
 *   doesn't hold its locks until the server's lifetime limit.
 *
 * PHP serves one request at a time per process, so one engine holds one Preview at a time; the
 * Preview's state is keyed by the request's recorder.
 */
final class MongoEngine
{
    /** The reason a standalone server, or any reply the binding doesn't recognise, runs in `guard` mode. */
    public const STANDALONE_REASON = "Preview unavailable: this MongoDB server doesn't support transactions";
    /**
     * The reason when the detection `hello` couldn't be sent or answered: whether the server supports
     * transactions is unknown, so the store runs in `guard` mode for now and asks again next time.
     */
    public const UNREACHABLE_REASON = "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode";
    /** The reason shown when the client's own commands never reached Sendproof's monitor. */
    public const UNMONITORED_REASON = "Preview unavailable: Sendproof's command monitor doesn't see this MongoDB client's commands";
    /** Below the server's 60-second `transactionLifetimeLimitSeconds`, so the binding, not the server, ends a long Preview. */
    public const DEFAULT_TIMEOUT_MS = 50_000;

    /** Commands the monitoring specification marks security-sensitive: never logged. */
    private const SENSITIVE = ['authenticate', 'saslstart', 'saslcontinue', 'getnonce', 'createuser', 'updateuser', 'copydbgetnonce', 'copydbsaslstart', 'copydb'];
    /** Fields the driver adds to every command; they carry no meaning for the log and are dropped. */
    private const ENVELOPE = ['lsid', 'txnNumber', 'autocommit', 'startTransaction', '$clusterTime', '$db', '$readPreference', 'readConcern', 'writeConcern', 'apiVersion', 'apiStrict', 'apiDeprecationErrors'];
    /** Most candidate documents read back for change capture in one Preview. */
    private const CANDIDATE_LIMIT = 1000;
    /** Server error codes meaning the collection or snapshot didn't exist at the start time: NamespaceNotFound, SnapshotUnavailable. */
    private const ABSENT_AT_START = [26, 246];
    /** `NoSuchTransaction`: the server has no such transaction, so nothing holds its locks. */
    private const NO_SUCH_TRANSACTION = 251;
    /**
     * How long, from the lost abort, the engine keeps trying to end the transaction, and the backoff
     * between tries: well inside the server's 60-second lifetime.
     */
    private const KILL_RETRY_LIMIT_MS = 10_000;
    private const KILL_FIRST_DELAY_MS = 100;
    private const KILL_MAX_DELAY_MS = 2_000;

    /** @var \WeakMap<Recorder,string> The mode each Preview began in; a Preview keeps it even if detection later changes */
    private \WeakMap $modes;
    /** @var \WeakMap<Recorder,MongoPreview> */
    private \WeakMap $states;
    /** @var array<int|string,array<string,mixed>> Commands seen by monitoring, kept until their reply arrives */
    private array $pending = [];
    /**
     * Above zero while any engine talks to the server itself, so monitoring ignores those commands.
     * Shared by every engine: the driver pools clients that share a URI, and every subscriber of a
     * pooled client sees every one of its commands.
     */
    private static int $internal = 0;
    /** @var array<string,array{0:MongoPreview,1:\WeakReference<Recorder>}> The open Preview transactions of every engine, by lsid */
    private static array $open = [];
    /** @var \WeakMap<object,\WeakMap<Recorder,true>>|null Monitoring events already handled for each recorder, so a pooled client's command is handled once */
    private static ?\WeakMap $handled = null;
    /**
     * @var list<array{0:MongoEngine,1:Session,2:int}> Sessions whose abort no reply acknowledged, with
     * the `hrtime` it was lost at. Each is held, so the driver can't hand its id to another operation,
     * until {@see endLostTransactions()} kills it.
     */
    private static array $lost = [];
    private static bool $shutdownRegistered = false;
    /** A PSR-3 logger (any object with `warning(string, array)`) for transactions the engine couldn't end; `error_log()` when null. */
    private static ?object $logger = null;
    /** Set while this engine aborts a Preview transaction: whether the driver sent the abort, and whether the server acknowledged it. */
    private ?\stdClass $aborting = null;
    /** The `comment` of this engine's own `hello`: seeing it proves the monitor is installed on this client. */
    private readonly string $probe;
    /** The subscriber registered on {@see $manager}: the tripwire, the `Db` log and change candidates. */
    private readonly MongoMonitor $monitor;
    /** Set once monitoring saw {@see $probe}. */
    private bool $probeSeen = false;
    /** @var array{mode:string,reason?:string}|null */
    private ?array $detected = null;
    /** The detected mode; known before any Preview runs, because {@see begin()} detects first. */
    public ?string $mode = null;

    /**
     * @param array<string,true>|null $reads Host-declared reads, lower-case names
     * @param (callable(): object)|null $hello Replaces the `hello` call, for tests that simulate a topology
     */
    public function __construct(
        public readonly Manager $manager,
        public readonly Guard $guard,
        private readonly ?array $reads = null,
        private readonly int $timeoutMs = self::DEFAULT_TIMEOUT_MS,
        private $hello = null,
    ) {
        $this->modes = new \WeakMap();
        $this->states = new \WeakMap();
        $this->probe = 'sendproof-monitor-' . bin2hex(random_bytes(8));
        $this->monitor = new MongoMonitor($this);
        $manager->addSubscriber($this->monitor);
    }

    /** The reason shown for a command MongoDB refuses inside a transaction. */
    public static function refusedReason(string $operation): string
    {
        return "Preview unavailable: MongoDB can't run {$operation} inside a transaction";
    }

    /** Commands on these databases can't join a transaction. */
    public static function systemDatabase(?string $name): bool
    {
        return $name === 'admin' || $name === 'config' || $name === 'local';
    }

    /** Runs engine-internal commands (topology, change capture, abort) without logging or tripping. */
    public function internal(callable $work): mixed
    {
        self::$internal++;
        try {
            return $work();
        } finally {
            self::$internal--;
        }
    }

    /**
     * Detects the topology: `preview` on a replica set or mongos with logical sessions, `guard` with
     * {@see STANDALONE_REASON} for a standalone server or any reply this doesn't recognise. When the
     * `hello` can't be sent or answered, `guard` with {@see UNREACHABLE_REASON} for now, and it is
     * asked again next time.
     *
     * @return array{mode:string,reason?:string}
     */
    public function detect(): array
    {
        if ($this->detected !== null) {
            return $this->detected;
        }
        try {
            $hello = $this->internal(fn (): object => $this->hello !== null
                ? ($this->hello)()
                : $this->manager->executeCommand('admin', new Command(['hello' => 1, 'comment' => $this->probe]))->toArray()[0]);
        } catch (ServerException) {
            // The server answered, with an error: not a reply that supports transactions.
            $hello = new \stdClass();
        } catch (\Throwable) {
            $this->mode ??= 'guard';

            return ['mode' => 'guard', 'reason' => self::UNREACHABLE_REASON];
        }
        $transactions = (!empty($hello->setName) || ($hello->msg ?? null) === 'isdbgrid') && ($hello->logicalSessionTimeoutMinutes ?? null) !== null;
        if (!$this->monitored()) {
            // The tripwire can't see this client: never claim a rollback (see begin()).
            $this->mode = 'guard';

            return $this->detected = ['mode' => 'guard', 'reason' => self::UNMONITORED_REASON];
        }
        $this->mode = $transactions ? 'preview' : 'guard';

        return $this->detected = $transactions ? ['mode' => 'preview'] : ['mode' => 'guard', 'reason' => self::STANDALONE_REASON];
    }

    /**
     * Whether this engine's monitor is installed on the client it guards, proven by its own `hello`
     * reaching it. Commands from some other client don't count. A topology supplied by a test
     * (`$hello`) sends no `hello`, so it is taken as monitored.
     */
    private function monitored(): bool
    {
        return $this->hello !== null || $this->probeSeen;
    }

    /** The current Preview's state, when this code runs in a `preview`-mode Preview that began. */
    public function state(): ?MongoPreview
    {
        $recorder = $this->guard->recorder();

        return $recorder->inPreviewScope() ? ($this->states[$recorder] ?? null) : null;
    }

    /** The mode the current Preview began in; `guard` for a Preview that never began on this store. */
    public function modeOf(Recorder $recorder): string
    {
        return $this->modes[$recorder] ?? 'guard';
    }

    /** Whether `$session` is the current Preview's own session. */
    public function isPreviewSession(?Session $session): bool
    {
        $state = $this->state();

        return $state !== null && $session === $state->session;
    }

    /** Prepares a Preview: detects the mode and, in `preview` mode, starts the session and transaction. */
    public function begin(Recorder $recorder): ?MongoPreview
    {
        // PHP runs one request at a time, so a transaction still open here belongs to a Preview that
        // never finished (a fatal error, `exit`, a worker that kept running): abort it now.
        foreach ($this->states as $stale) {
            $this->end($stale);
        }
        // A long-lived worker runs no shutdown work between requests: one more try for any session
        // still waiting to be killed.
        if (self::$lost !== []) {
            self::endLostTransactions(false);
        }
        unset($this->states[$recorder], $this->modes[$recorder]);
        if (!$recorder->inPreviewScope()) {
            return null;
        }
        $detected = $this->detect();
        if (($detected['reason'] ?? null) === self::UNMONITORED_REASON) {
            throw new \RuntimeException('The MongoDB command monitor is not installed on the guarded client, so a write that escaped the Preview could not be detected.');
        }
        $mode = $detected['mode'];
        $this->modes[$recorder] = $mode;
        if ($mode !== 'preview') {
            return null;
        }
        $session = $this->manager->startSession();
        $session->startTransaction(['readConcern' => new ReadConcern(ReadConcern::SNAPSHOT), 'writeConcern' => new WriteConcern(WriteConcern::MAJORITY)]);
        $lsid = self::lsidHex($session->getLogicalSessionId());
        if ($lsid === null) {
            throw new \RuntimeException('The MongoDB driver did not expose the Preview session id.');
        }
        $state = new MongoPreview($session, $lsid, hrtime(true) + $this->timeoutMs * 1_000_000);
        $this->states[$recorder] = $state;
        self::$open[$lsid] = [$state, \WeakReference::create($recorder)];

        return $state;
    }

    /**
     * Classifies a command before it is sent and lets the guard refuse it. In `guard` mode every
     * write blocks; in `preview` mode only what MongoDB can't run inside a transaction does. A
     * command on the admin, config or local database runs outside the transaction, so its writes
     * block too.
     *
     * @param array<string,mixed>|object $command
     * @throws \Sendproof\Core\Stores\PreviewWriteBlockedException
     * @throws PreviewTransactionControlException
     */
    public function check(array|object $command, ?string $operation = null, ?string $database = null): void
    {
        $recorder = $this->guard->recorder();
        if (!$recorder->inPreviewScope()) {
            return;
        }
        $document = Classifier::asArray($command) ?? [];
        $operation ??= (string) (array_key_first($document) ?? 'command');
        if (self::endsTransaction(strtolower($operation))) {
            throw $this->guard->refuse("Preview owns the MongoDB transaction, so the handler's {$operation} cannot run during Preview.");
        }
        if (($state = $this->states[$recorder] ?? null) !== null) {
            if ($state->finished) {
                // Code still running in the Preview's request after it ended (a terminating callback, an
                // after-response job run inline): its session is gone, so nothing may be sent at all.
                throw $this->guard->refuse('The Preview has ended, so its MongoDB session refuses every further call.')
                    ?? new PreviewTransactionControlException('The Preview has ended, so its MongoDB session refuses every further call.');
            }
            $this->enforceDeadline($recorder, $state);
        }
        ['kind' => $kind, 'refusedInTransaction' => $refused] = Classifier::mongo($command, $this->reads);
        if ($this->modeOf($recorder) === 'preview' && !self::systemDatabase($database)) {
            if ($refused !== null) {
                $this->guard->guard('mongodb', $operation, CommandKind::Write, self::refusedReason($refused));
            }

            return;
        }
        $this->guard->guard('mongodb', $operation, $kind);
    }

    /** A Preview past its limit loses its transaction: later commands fail, nothing commits, and it answers 500. */
    private function enforceDeadline(Recorder $recorder, MongoPreview $state): void
    {
        if ($state->finished || hrtime(true) <= $state->deadlineNs) {
            return;
        }
        $error = new PreviewTransactionControlException("The Preview ran longer than {$this->timeoutMs} ms, so its MongoDB transaction was aborted.");
        $recorder->refuse($error);
        $this->end($state);

        throw $error;
    }

    // ---- Monitoring ----

    /** @internal Called by {@see MongoMonitor} */
    public function started(CommandStartedEvent $event): void
    {
        $command = $event->getCommand();
        if (($command->comment ?? null) === $this->probe) {
            $this->probeSeen = true;
        }
        // The driver sends abortTransaction only when a command was sent in the transaction.
        if ($this->aborting !== null && $event->getCommandName() === 'abortTransaction') {
            $this->aborting->sent = true;
        }
        if (self::$internal > 0) {
            return;
        }
        // A pooled client hands the same event to every engine's subscriber: for each request's
        // recorder, the first engine handles it.
        $recorder = $this->guard->recorder();
        self::$handled ??= new \WeakMap();
        $seen = self::$handled[$event] ??= new \WeakMap();
        if (isset($seen[$recorder])) {
            return;
        }
        $seen[$recorder] = true;
        $name = $event->getCommandName();
        $lower = strtolower($name);
        $kind = Classifier::mongo($command, $this->reads)['kind'];
        $preview = $recorder->inPreviewScope();
        // Sent on the Preview session: the server now holds the transaction until an abort reaches it.
        if ($preview && ($open = self::openState($recorder, $command)) !== null) {
            $open->opened = true;
        }
        if ($preview && self::endsTransaction($lower)) {
            // Sent around the hook, for example through a raw driver call: it may have committed
            // the Preview transaction, so the Preview can never be confirmed.
            $recorder->refuse(new PreviewTransactionControlException("A MongoDB {$name} reached the server during a Preview; the Preview can't be confirmed."));
        } elseif ($preview && $kind === CommandKind::Write) {
            $this->watchWrite($recorder, $command, $event->getDatabaseName(), $lower);
        }
        if ($kind === CommandKind::Session || in_array($lower, self::SENSITIVE, true)) {
            return;
        }
        $fields = (array) $command;
        $body = array_filter($fields, static fn ($field): bool => !in_array($field, self::ENVELOPE, true), ARRAY_FILTER_USE_KEY);
        $first = $fields[$name] ?? null;
        $this->pending[$event->getRequestId()] = [
            'capture' => $recorder->isCapturing() ? $recorder : null,
            'preview' => $preview ? $recorder : null,
            'name' => $name,
            'namespace' => $event->getDatabaseName(),
            'target' => is_string($first) ? $first : null,
            'statement' => json_encode(Guard::sanitizeDocument((object) $body), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR),
            'command' => $command,
        ];
    }

    /** A write seen during a Preview: collect change candidates, or trip if it escaped the session. */
    private function watchWrite(Recorder $preview, object $command, string $namespace, string $lower): void
    {
        // The Preview transaction it names, on whichever engine owns it (pooled clients share monitoring).
        $state = self::openState($preview, $command);
        // Only a command inside the Preview transaction (its lsid and autocommit: false) rolls back.
        if ($state === null || ($command->autocommit ?? null) !== false) {
            // The hook couldn't stop it and nothing can undo it: never claim a rollback.
            $preview->refuse(new PreviewTransactionControlException("A MongoDB {$lower} escaped the Preview session; the Preview can't be confirmed."));

            return;
        }
        $state->used = true;
        $fields = (array) $command;
        $collection = is_string($first = reset($fields)) ? $first : '';
        switch ($lower) {
            case 'insert':
                foreach ((array) ($command->documents ?? []) as $document) {
                    $this->candidate($state, ['namespace' => $namespace, 'collection' => $collection, 'id' => self::field($document, '_id'), 'via' => null]);
                }
                break;
            case 'update':
                foreach ((array) ($command->updates ?? []) as $update) {
                    $via = self::field($update, 'upsert') ? 'upsert' : (self::replaces(self::field($update, 'u')) ? 'replace' : null);
                    $state->filters[] = ['namespace' => $namespace, 'collection' => $collection, 'filter' => self::field($update, 'q') ?? new \stdClass(), 'via' => $via];
                }
                break;
            case 'delete':
                foreach ((array) ($command->deletes ?? []) as $remove) {
                    $state->filters[] = ['namespace' => $namespace, 'collection' => $collection, 'filter' => self::field($remove, 'q') ?? new \stdClass(), 'via' => null];
                }
                break;
            case 'findandmodify':
                $via = ($command->upsert ?? false) ? 'upsert' : (self::replaces($command->update ?? null) ? 'replace' : null);
                $state->filters[] = ['namespace' => $namespace, 'collection' => $collection, 'filter' => $command->query ?? new \stdClass(), 'via' => $via];
                break;
            case 'bulkwrite':
                // The client-level bulkWrite command: each op names its namespace by index.
                $namespaces = array_map(static fn ($info): array => explode('.', (string) self::field($info, 'ns'), 2), (array) ($command->nsInfo ?? []));
                foreach ((array) ($command->ops ?? []) as $op) {
                    $index = self::field($op, 'insert') ?? self::field($op, 'update') ?? self::field($op, 'delete');
                    [$database, $target] = ($namespaces[(int) $index] ?? []) + [$namespace, ''];
                    if (($document = self::field($op, 'document')) !== null) {
                        $this->candidate($state, ['namespace' => $database, 'collection' => $target, 'id' => self::field($document, '_id'), 'via' => null]);
                    } else {
                        $state->filters[] = ['namespace' => $database, 'collection' => $target, 'filter' => self::field($op, 'filter') ?? new \stdClass(), 'via' => self::field($op, 'upsert') ? 'upsert' : null];
                    }
                }
                break;
        }
    }

    /** @param array{namespace:string,collection:string,id:mixed,via:?string} $candidate */
    private function candidate(MongoPreview $state, array $candidate): void
    {
        if ($candidate['id'] === null) {
            return;
        }
        $key = $candidate['namespace'] . "\0" . $candidate['collection'] . "\0" . Bson::idKey($candidate['id']);
        $known = $state->candidates[$key] ?? null;
        if ($known === null || ($known['via'] === null && $candidate['via'] !== null)) {
            $state->candidates[$key] = $candidate;
        }
    }

    /** @internal Called by {@see MongoMonitor} */
    public function succeeded(CommandSucceededEvent $event): void
    {
        if ($this->aborting !== null && $event->getCommandName() === 'abortTransaction') {
            $this->aborting->acknowledged = true;
        }
        $pending = $this->take($event->getRequestId());
        if ($pending === null) {
            return;
        }
        $reply = $event->getReply();
        $state = $pending['preview'] !== null ? self::openState($pending['preview'], $pending['command']) : null;
        // The first reply in the transaction carries its snapshot time (the read timestamp).
        if ($state !== null && $state->startTime === null && isset($reply->operationTime)) {
            $state->startTime = $reply->operationTime;
        }
        if ($state !== null && $pending['target'] !== null) {
            $namespace = $pending['namespace'];
            $collection = $pending['target'];
            // Upserted ids appear only in the reply.
            foreach ((array) ($reply->upserted ?? []) as $upsert) {
                $this->candidate($state, ['namespace' => $namespace, 'collection' => $collection, 'id' => self::field($upsert, '_id'), 'via' => 'upsert']);
            }
            if (strtolower($pending['name']) === 'findandmodify' && ($id = self::field($reply->value ?? null, '_id')) !== null) {
                $this->candidate($state, ['namespace' => $namespace, 'collection' => $collection, 'id' => $id, 'via' => null]);
            }
            if (($upserted = $reply->lastErrorObject->upserted ?? null) !== null) {
                $this->candidate($state, ['namespace' => $namespace, 'collection' => $collection, 'id' => $upserted, 'via' => 'upsert']);
            }
        }
        $rows = null;
        if (isset($reply->cursor)) {
            $batch = $reply->cursor->firstBatch ?? $reply->cursor->nextBatch ?? [];
            $rows = is_countable($batch) ? count($batch) : null;
        } elseif (isset($reply->n) && is_int($reply->n)) {
            $rows = $reply->n;
        }
        $this->log($pending, $event->getDurationMicros() / 1000, $rows);
    }

    /** @internal Called by {@see MongoMonitor} */
    public function failed(CommandFailedEvent $event): void
    {
        // A network error carries no server reply: it proves nothing reached the server.
        if ($this->aborting !== null && $event->getCommandName() === 'abortTransaction' && ($event->getReply()->code ?? null) === self::NO_SUCH_TRANSACTION) {
            $this->aborting->acknowledged = true;
        }
        $pending = $this->take($event->getRequestId());
        if ($pending === null) {
            return;
        }
        $error = $event->getError();
        // The server refused something a transaction can't do and applied nothing: a block, not a crash.
        if ($pending['preview'] !== null && self::openState($pending['preview'], $pending['command']) !== null && $error->getCode() === 263) {
            $pending['preview']->block(['store' => 'mongodb', 'operation' => $pending['name'], 'detail' => self::refusedReason($pending['name'])]);
        }
        $reply = $event->getReply();
        $code = $reply->codeName ?? (new \ReflectionClass($error))->getShortName();
        $this->log($pending, $event->getDurationMicros() / 1000, null, (string) $code);
    }

    /** @return array<string,mixed>|null */
    private function take(int|string $requestId): ?array
    {
        $pending = $this->pending[$requestId] ?? null;
        unset($this->pending[$requestId]);

        return $pending;
    }

    /** @param array<string,mixed> $pending */
    private function log(array $pending, float $elapsedMs, ?int $rows, ?string $error = null): void
    {
        $pending['capture']?->db([
            'system' => 'mongodb',
            'operation' => $pending['name'],
            'namespace' => $pending['namespace'],
            'target' => $pending['target'],
            'statement' => $pending['statement'] === false ? null : $pending['statement'],
            'rowsAffected' => $rows,
            'error' => $error,
            'elapsedMs' => $elapsedMs,
        ]);
    }

    // ---- Finish ----

    /**
     * After the handler: captures document changes, then aborts the transaction and ends the
     * session. A capture read that fails for any reason but an already-aborted transaction throws,
     * after the abort, so the Preview answers 500, as does an abort the server never acknowledged.
     * Nothing the Preview wrote is ever committed: no `commitTransaction` is ever sent for the
     * Preview session.
     */
    public function finish(Recorder $recorder): void
    {
        $state = $this->states[$recorder] ?? null;
        if ($state === null || $state->finished) {
            return;
        }
        $failure = null;
        // MongoDB has no savepoints: a handler that aborted its own (joined) transaction asked to undo part
        // of the Preview's work, which can't be done, so the Preview can't be confirmed.
        foreach ($state->shells as $shell) {
            if ($state->shells[$shell] && $shell->getTransactionState() === Session::TRANSACTION_ABORTED) {
                $recorder->refuse(new PreviewTransactionControlException("The handler rolled back its MongoDB transaction, which joined the Preview's; MongoDB can't undo part of a transaction, so the Preview can't be confirmed."));
                break;
            }
        }
        try {
            if (hrtime(true) > $state->deadlineNs) {
                $recorder->refuse(new PreviewTransactionControlException("The Preview ran longer than {$this->timeoutMs} ms, so its MongoDB transaction was aborted."));
            } elseif ($state->used) {
                $this->internal(fn () => $this->capture($recorder, $state));
            }
        } catch (ServerException $error) {
            // A failed command inside a transaction makes the server abort it: nothing to capture.
            if ($error->getCode() !== 251 /* NoSuchTransaction */) {
                $failure = $error;
            }
        } catch (\Throwable $error) {
            $failure = $error;
        } finally {
            $this->end($state);
        }
        if ($failure === null && $state->lost) {
            // The server may still hold the transaction's locks; the session is killed once the response is out.
            $failure = new PreviewTransactionControlException("MongoDB didn't acknowledge the abort of the Preview transaction, so the rollback can't be confirmed.");
        }
        if ($failure !== null) {
            throw $failure;
        }
    }

    /**
     * Aborts the Preview transaction and ends its session, once.
     *
     * The driver ignores abort errors, as the transactions specification requires: an unacknowledged
     * abort still commits nothing, because no `commitTransaction` is ever sent for the Preview
     * session. But the server then keeps the transaction, and its locks, until its 60-second lifetime
     * limit. So when a command was sent on the session (or the driver sent its abort) and no reply
     * acknowledged the abort, the session is held, not ended, and killed with `killSessions` once the
     * response is out ({@see endLostTransactions()}). The driver may not even send the abort: a
     * dropped connection can leave it no server to select.
     */
    private function end(MongoPreview $state): void
    {
        if ($state->finished) {
            return;
        }
        $state->finished = true;
        unset(self::$open[$state->lsid]);
        $session = $state->session;
        if ($session->isInTransaction()) {
            $this->aborting = (object) ['sent' => false, 'acknowledged' => false];
            try {
                $this->internal(static fn () => $session->abortTransaction());
            } catch (\Throwable) {
                // The driver ignores abort errors itself; the reply, seen by monitoring, decides.
            } finally {
                $aborting = $this->aborting;
                $this->aborting = null;
            }
            if (!$aborting->acknowledged && ($state->opened || $aborting->sent)) {
                $state->lost = true;
                $this->lose($session);

                return;
            }
        }
        $this->release($session);
    }

    /** Holds a session whose abort was lost until {@see endLostTransactions()} kills it, after the response. */
    private function lose(Session $session): void
    {
        self::$lost[] = [$this, $session, hrtime(true)];
        if (self::$shutdownRegistered) {
            return;
        }
        self::$shutdownRegistered = true;
        register_shutdown_function(static function (): void {
            if (self::$lost === []) {
                return;
            }
            // Under PHP-FPM, send the response first, so the client never waits for the retries.
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            self::endLostTransactions();
        });
    }

    /**
     * Sends the warning about a Preview transaction the engine couldn't end to `$logger`, a PSR-3
     * logger such as the framework's (any object with `warning(string $message, array $context)`).
     * Null restores the default, `error_log()`.
     */
    public static function useLogger(?object $logger): void
    {
        if ($logger !== null && !method_exists($logger, 'warning')) {
            throw new \InvalidArgumentException('The MongoDB warning logger needs a warning(string, array) method, as a PSR-3 logger has.');
        }
        self::$logger = $logger;
    }

    /**
     * Ends every Preview transaction whose abort no reply acknowledged, with `killSessions` on its
     * session. With `$wait`, it retries with backoff (100 ms doubling to 2 s) while the server can't
     * be reached, until about 10 s after the abort was lost; a final failure is logged with the
     * session id as a warning through the logger given to {@see useLogger()}, or `error_log()`, and
     * the server then ends the transaction, and releases its locks, at its lifetime limit. Without
     * `$wait`, it tries each once and keeps the ones that fail for later.
     *
     * The engine runs it from a shutdown function, after the response is sent, and once more as the
     * next Preview begins. The Laravel and Symfony adapters also run it after every request
     * (`terminating()`, `kernel.terminate`), so a long-lived worker (Octane, RoadRunner, FrankenPHP)
     * kills a lost session promptly; any other long-lived worker should call it between requests.
     */
    public static function endLostTransactions(bool $wait = true): void
    {
        foreach (self::$lost as $key => [$engine, $session, $lostAt]) {
            $deadline = $lostAt + self::KILL_RETRY_LIMIT_MS * 1_000_000;
            $failure = $engine->kill($session->getLogicalSessionId(), $wait ? $deadline : 0);
            if ($failure !== null && !$wait && hrtime(true) < $deadline) {
                continue;
            }
            unset(self::$lost[$key]);
            if ($failure !== null) {
                $id = self::lsidHex($session->getLogicalSessionId()) ?? 'unknown';
                $message = "Sendproof couldn't end a MongoDB Preview transaction (session {$id}): {$failure}. The server ends it, and releases its locks, at transactionLifetimeLimitSeconds.";
                if (self::$logger !== null) {
                    self::$logger->warning($message, ['session' => $id]);
                } else {
                    error_log('Sendproof warning: ' . $message);
                }
            }
            $engine->release($session);
        }
        self::$lost = array_values(self::$lost);
    }

    /**
     * Sends `killSessions` for the session `$lsid`, retrying network failures with backoff until
     * `$untilNs` (`hrtime`). Returns null once the server ended the session, or why it couldn't.
     *
     * The driver has no per-command timeout, so a try takes what the client's options allow. With the
     * default `serverSelectionTryOnce`, a try fails at once while the server is in the driver's
     * 5-second cooldown after a failed check, and otherwise takes at most `connectTimeoutMS` (10 s by
     * default, reached only by a host that drops packets).
     */
    private function kill(object $lsid, int $untilNs): ?string
    {
        $delayMs = self::KILL_FIRST_DELAY_MS;
        while (true) {
            try {
                $this->internal(fn () => $this->manager->executeCommand('admin', new Command(['killSessions' => [$lsid]])));

                return null;
            } catch (ServerException $error) {
                return $error->getMessage();
            } catch (\Throwable $error) {
                // A network error or no server to select: try again shortly.
                if (hrtime(true) + $delayMs * 1_000_000 > $untilNs) {
                    return sprintf("MongoDB couldn't be reached for %d s (%s)", intdiv(self::KILL_RETRY_LIMIT_MS, 1000), $error->getMessage());
                }
                usleep($delayMs * 1000);
                $delayMs = min($delayMs * 2, self::KILL_MAX_DELAY_MS);
            }
        }
    }

    /** Ends the driver session. */
    private function release(Session $session): void
    {
        try {
            $this->internal(static fn () => $session->endSession());
        } catch (\Throwable) {
            // Nothing more to release.
        }
    }

    /**
     * Runs a command that returns a cursor (`find`) and returns its documents. The driver unwraps
     * the command's `cursor.firstBatch`, so a `singleBatch` command yields every document.
     *
     * @param array<string,mixed> $command
     * @return list<Document>
     */
    private function rows(string $database, array $command, ?Session $session = null): array
    {
        $cursor = $this->manager->executeCommand($database, new Command($command), $session === null ? [] : ['session' => $session]);
        $cursor->setTypeMap(['root' => 'bson', 'document' => 'bson', 'array' => 'bson']);

        return array_values($cursor->toArray());
    }

    /**
     * Finds documents as they were when the Preview transaction started: a snapshot read at its
     * start time, outside the transaction. Without a start time (no reply carried one), it reads
     * the majority-committed view, which the spec allows: nothing the Preview wrote is committed,
     * so the only difference is a concurrent commit by another request.
     *
     * @return list<Document>
     */
    private function atStart(MongoPreview $state, string $namespace, string $collection, mixed $filter, ?array $projection = null): array
    {
        $readConcern = $state->startTime === null ? ['level' => 'majority'] : ['level' => 'snapshot', 'atClusterTime' => $state->startTime];
        $find = ['find' => $collection, 'filter' => $filter, 'batchSize' => self::CANDIDATE_LIMIT, 'limit' => self::CANDIDATE_LIMIT, 'singleBatch' => true, 'readConcern' => $readConcern];
        if ($projection !== null) {
            $find['projection'] = $projection;
        }
        try {
            return $this->rows($namespace, $find);
        } catch (ServerException $error) {
            // The collection was created after the start time: nothing in it existed then.
            if (in_array($error->getCode(), self::ABSENT_AT_START, true)) {
                return [];
            }
            throw $error;
        }
    }

    /** Compares each candidate's start-time and in-transaction versions and records the differences. */
    private function capture(Recorder $recorder, MongoPreview $state): void
    {
        foreach ($state->filters as ['namespace' => $namespace, 'collection' => $collection, 'filter' => $filter, 'via' => $via]) {
            $inside = $this->rows($namespace, ['find' => $collection, 'filter' => $filter, 'projection' => ['_id' => 1], 'batchSize' => self::CANDIDATE_LIMIT, 'limit' => self::CANDIDATE_LIMIT, 'singleBatch' => true], $state->session);
            foreach ([...$inside, ...$this->atStart($state, $namespace, $collection, $filter, ['_id' => 1])] as $document) {
                $this->candidate($state, ['namespace' => $namespace, 'collection' => $collection, 'id' => $document->get('_id'), 'via' => $via]);
                if (count($state->candidates) >= self::CANDIDATE_LIMIT) {
                    break;
                }
            }
        }
        $read = 0;
        foreach ($state->candidates as ['namespace' => $namespace, 'collection' => $collection, 'id' => $id, 'via' => $via]) {
            if ($read++ >= self::CANDIDATE_LIMIT) {
                $recorder->truncateChanges();
                break;
            }
            $before = $this->atStart($state, $namespace, $collection, ['_id' => $id])[0] ?? null;
            $after = $this->rows($namespace, ['find' => $collection, 'filter' => ['_id' => $id], 'limit' => 1, 'singleBatch' => true], $state->session)[0] ?? null;
            if ($before !== null && $after !== null && Bson::text($before) === Bson::text($after)) {
                continue;
            }
            if ($before === null && $after === null) {
                continue;
            }
            $operation = $before === null ? 'insert' : ($after === null ? 'delete' : 'update');
            $change = [
                'operation' => $operation, 'store' => 'mongodb', 'namespace' => $namespace, 'table' => $collection,
                'key' => ['_id' => Bson::plain($id)], 'before' => $before === null ? null : Bson::plain($before), 'after' => $after === null ? null : Bson::plain($after),
            ];
            if ($via !== null && $operation !== 'delete') {
                $change['via'] = $via;
            }
            $recorder->recordChange($change);
        }
    }

    // ---- Helpers ----

    /**
     * The open Preview transaction a command carries, by its `lsid`, when it belongs to `$preview`.
     * Any engine's Preview counts: the driver pools clients that share a URI, so one engine's
     * monitor sees another hooked client's commands.
     */
    private static function openState(Recorder $preview, object $command): ?MongoPreview
    {
        $lsid = self::lsidHex($command->lsid ?? null);
        [$state, $owner] = $lsid === null ? [null, null] : (self::$open[$lsid] ?? [null, null]);

        return $state !== null && !$state->finished && $owner->get() === $preview ? $state : null;
    }

    /** Commands that end a transaction. In a Preview only the engine may send them. */
    private static function endsTransaction(string $name): bool
    {
        return $name === 'committransaction' || $name === 'aborttransaction';
    }

    /** Lower-case hex of a session id (`lsid.id`, a BSON UUID), comparable across driver versions. */
    public static function lsidHex(mixed $lsid): ?string
    {
        $id = is_object($lsid) ? ($lsid->id ?? null) : (is_array($lsid) ? ($lsid['id'] ?? null) : null);

        return $id instanceof \MongoDB\BSON\Binary ? bin2hex($id->getData()) : null;
    }

    /** A field of a command sub-document, which the driver decodes as an object or an array. */
    private static function field(mixed $document, string $name): mixed
    {
        return is_object($document) ? ($document->{$name} ?? null) : (is_array($document) ? ($document[$name] ?? null) : null);
    }

    /** Whether an update document replaces the whole document rather than applying operators or a pipeline. */
    private static function replaces(mixed $update): bool
    {
        $fields = is_object($update) ? (array) $update : (is_array($update) && !array_is_list($update) ? $update : []);

        return $fields !== [] && !str_starts_with((string) array_key_first($fields), '$');
    }
}
