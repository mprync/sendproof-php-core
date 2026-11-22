<?php

declare(strict_types=1);

namespace Sendproof\Core\Capture;

use Sendproof\Core\Limits;

/**
 * Collects logs, effects and SQL for one request while a preview or observed send is running.
 *
 * Hosts call `tryRecord*` before an external effect. In a preview the method returns true and
 * the host must skip the effect. In an observed send it records the effect as delivered and
 * returns false, so the host proceeds. Outside both modes nothing is recorded.
 */
final class Recorder
{
    private bool $active = false;
    private bool $rollback = false;
    private bool $logsTruncated = false;
    private bool $effectsTruncated = false;
    private int $logSize = 0;
    private int $effectSize = 0;
    private int $requestStart = 0;
    private float $dbMs = 0.0;
    private int $queries = 0;
    private float $serializeMs = 0.0;
    /** @var list<array<string,mixed>> */
    private array $effects = [];
    /** @var list<array<string,mixed>> */
    private array $logs = [];
    /** @var list<array<string,mixed>> Document, item and key changes reported by data-store hooks. */
    private array $changes = [];
    private bool $changesTruncated = false;
    /** True from the start of a Preview until the next capture begins, even after the Preview finished. */
    private bool $previewScope = false;
    /** @var array{store:string,operation:string,detail:string}|null The first write the guard refused. */
    private ?array $blocked = null;
    /** A transaction-control refusal: the Preview answers 500 whatever the handler returns. */
    private ?\Throwable $fault = null;
    /** @var array<string,string> Connections whose Preview transaction the server ended, with the reason */
    private array $ended = [];

    /** True while a rollback-only preview is running in this request. */
    public function isPreview(): bool
    {
        return $this->active && $this->rollback;
    }

    /**
     * True while this request belongs to a Preview, even after the Preview finished. Store hooks use
     * it, so a write sent after the Preview settled (a terminating callback, a shutdown function) is
     * still refused and never sent unguarded.
     */
    public function inPreviewScope(): bool
    {
        return $this->previewScope;
    }

    /**
     * Keeps the first refused write; it decides the Preview's 409 whatever the handler returns.
     *
     * @param array{store:string,operation:string,detail:string} $write
     */
    public function block(array $write): void
    {
        if (!$this->previewScope || $this->blocked !== null) {
            return;
        }
        $this->blocked = [
            'store' => Limits::clip($write['store'], Limits::NAME),
            'operation' => Limits::clip($write['operation'], Limits::NAME),
            'detail' => Limits::clip($write['detail']),
        ];
    }

    /** Keeps the first fault; it withholds confirmation whatever the handler returns. */
    public function refuse(\Throwable $fault): void
    {
        if ($this->previewScope) {
            $this->fault ??= $fault;
        }
    }

    /**
     * Records that the server itself ended the Preview transaction on one connection (a MySQL
     * deadlock, or a lock wait timeout with `innodb_rollback_on_timeout`): every later statement on
     * it would run outside the transaction, so the provider refuses them all, and the Preview
     * answers 500 without confirmation.
     *
     * @param string $connection the provider's key for the connection
     */
    public function endTransaction(string $connection, string $reason): void
    {
        if (!$this->previewScope) {
            return;
        }
        $this->ended[$connection] ??= $reason;
        $this->refuse(new \Sendproof\Core\Stores\PreviewTransactionControlException("The Preview can't be confirmed: {$reason}."));
    }

    /** Why the server ended the Preview transaction on `$connection`, or null when it didn't. */
    public function transactionEnded(string $connection): ?string
    {
        return $this->ended[$connection] ?? null;
    }

    /** @return array{store:string,operation:string,detail:string}|null */
    public function blocked(): ?array
    {
        return $this->blocked;
    }

    public function fault(): ?\Throwable
    {
        return $this->fault;
    }

    /**
     * Records a document, item or key change. Secret-named fields (for example `password_hash`)
     * never leave the process, at any depth of a nested document.
     *
     * @param array{operation:string,table:string,key:mixed,before:mixed,after:mixed,store?:string,namespace?:string,via?:string} $change
     */
    public function recordChange(array $change): void
    {
        if (!$this->active) {
            return;
        }
        if (count($this->changes) >= Limits::CHANGES) {
            $this->changesTruncated = true;

            return;
        }
        foreach (['key', 'before', 'after'] as $field) {
            $change[$field] = SqlRedactor::redactDeep($change[$field] ?? null);
        }
        $this->changes[] = $change;
    }

    /** Marks the change list as incomplete, for example when a hook stops reading candidates. */
    public function truncateChanges(): void
    {
        if ($this->active) {
            $this->changesTruncated = true;
        }
    }

    /**
     * Records one data-store command as a `Db` log entry. The message is the OpenTelemetry span name,
     * `{operation} {target}`. Hooks pass sanitised statements only: values never reach this method.
     *
     * @param array{system:string,operation:string,target?:?string,namespace?:?string,statement?:?string,rowsAffected?:?int,blocked?:bool,error?:?string,elapsedMs?:?float} $command
     */
    public function db(array $command): void
    {
        if (!$this->active) {
            return;
        }
        $blocked = ($command['blocked'] ?? false) === true;
        $elapsed = isset($command['elapsedMs']) ? max(0.0, (float) $command['elapsedMs']) : null;
        if (!$blocked) {
            $this->queries = min(PHP_INT_MAX, $this->queries + 1);
            $this->dbMs += $elapsed ?? 0.0;
        }
        if (!$this->hasLogRoom()) {
            return;
        }

        $db = ['system' => $this->clip($command['system'], Limits::NAME), 'operation' => $this->clip($command['operation'], Limits::NAME)];
        foreach (['target', 'namespace'] as $field) {
            if (isset($command[$field]) && $command[$field] !== '') {
                $db[$field] = $this->clip((string) $command[$field], Limits::NAME);
            }
        }
        if (isset($command['statement']) && $command['statement'] !== '') {
            $db['statement'] = $this->clip((string) $command['statement']);
        }
        if (isset($command['rowsAffected']) && $command['rowsAffected'] >= 0) {
            $db['rowsAffected'] = (int) $command['rowsAffected'];
        }
        if ($blocked) {
            $db['blocked'] = true;
        }
        if (isset($command['error']) && $command['error'] !== '') {
            $db['error'] = $this->clip((string) $command['error'], Limits::NAME);
        }

        $entry = ['level' => 'Db', 'message' => isset($db['target']) ? $db['operation'] . ' ' . $db['target'] : $db['operation']];
        $entry['offsetMs'] = max(0.0, $this->offsetMs() - ($elapsed ?? 0.0));
        if ($elapsed !== null) {
            $entry['elapsedMs'] = $elapsed;
        }
        $entry['db'] = $db;
        $this->add($entry);
    }

    /** True while either a preview or an observed send is capturing. */
    public function isCapturing(): bool
    {
        return $this->active;
    }

    public function begin(bool $rollback, ?int $requestStart = null): void
    {
        $this->reset();
        $this->requestStart = $requestStart ?? hrtime(true);
        $this->rollback = $rollback;
        $this->previewScope = $rollback;
        $this->active = true;
    }

    /** Forgets everything, including a finished Preview's scope. Long-running workers call it between requests. */
    public function forget(): void
    {
        $this->reset();
        $this->active = false;
        $this->rollback = false;
        $this->previewScope = false;
    }

    /** Records an effect and returns true when the host must suppress its delivery. */
    public function tryRecordEffect(string $kind, string $description, mixed $data = null): bool
    {
        if (!$this->active) {
            return false;
        }
        if (count($this->effects) === Limits::EFFECTS || $this->effectSize >= Limits::LOG_BUDGET) {
            $this->effectsTruncated = true;
            return $this->rollback;
        }

        $started = hrtime(true);
        $truncated = false;
        $captured = $data === null ? null : Limits::payload($data, $truncated);
        $this->serializeMs += (hrtime(true) - $started) / 1e6;
        $capturedKind = Limits::clip($kind, Limits::NAME);
        $capturedDescription = Limits::clip($description);
        $this->effectSize += strlen($capturedKind) + strlen($capturedDescription) + Limits::size($captured);
        $this->effectsTruncated = $this->effectsTruncated || $truncated || $capturedKind !== $kind || $capturedDescription !== $description;
        if ($this->effectSize <= Limits::LOG_BUDGET) {
            $effect = ['kind' => $capturedKind, 'description' => $capturedDescription, 'data' => $captured];
            if (!$this->rollback) {
                $effect['delivered'] = true;
            }
            $this->effects[] = $effect;
        } else {
            $this->effectsTruncated = true;
        }

        return $this->rollback;
    }

    /** @param iterable<string> $to @param iterable<string> $cc */
    public function tryRecordEmail(string $description, string $from, iterable $to, iterable $cc, string $subject, string $text, ?string $html = null): bool
    {
        return $this->tryRecordEffect('email', $description, [
            'from' => $from, 'to' => [...$to], 'cc' => [...$cc], 'subject' => $subject, 'text' => $text, 'html' => $html,
        ]);
    }

    public function tryRecordHttp(string $description, string $method, string $url, ?int $status = null, mixed $body = null): bool
    {
        return $this->tryRecordEffect('http', $description, ['method' => $method, 'url' => $url, 'status' => $status, 'body' => $body]);
    }

    public function tryRecordJob(string $description, string $name, mixed $arguments, ?string $queue = null, ?\DateTimeInterface $runAt = null): bool
    {
        return $this->tryRecordEffect('job', $description, ['name' => $name, 'arguments' => $arguments, 'queue' => $queue, 'runAt' => $runAt?->format(\DateTimeInterface::ATOM)]);
    }

    public function tryRecordMessage(string $description, string $topic, mixed $payload, ?string $key = null): bool
    {
        return $this->tryRecordEffect('message', $description, ['topic' => $topic, 'payload' => $payload, 'key' => $key]);
    }

    /** Records a simple log entry and reports whether capture is active. */
    public function tryRecordLog(string $level, string $message): bool
    {
        if (!$this->active) {
            return false;
        }
        $this->log($level, $message);

        return true;
    }

    /**
     * Records a structured log entry.
     *
     * @param array<string,mixed> $properties
     * @param array{id:int,name?:string}|null $eventId
     * @param array{type:string,message:string}|null $exception
     */
    public function log(string $level, string $message, ?string $category = null, array $properties = [], ?array $eventId = null, ?array $exception = null): void
    {
        if (!$this->active || !$this->hasLogRoom()) {
            return;
        }

        $entry = ['level' => $this->clip($level, Limits::NAME), 'message' => $this->clip($message)];
        if ($category !== null) {
            $entry['category'] = $this->clip($category, Limits::NAME);
        }
        if ($eventId !== null) {
            $entry['eventId'] = $eventId;
        }
        $entry['offsetMs'] = $this->offsetMs();
        $captured = [];
        foreach ($properties as $name => $value) {
            if (count($captured) === Limits::PROPERTIES) {
                $this->logsTruncated = true;
                break;
            }
            $text = is_scalar($value) || $value === null || $value instanceof \Stringable
                ? (string) $value
                : (json_encode($value, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) ?: '');
            $captured[$this->clip((string) $name, Limits::NAME)] = $this->clip($text);
        }
        if ($captured !== []) {
            $entry['properties'] = $captured;
        }
        if ($exception !== null) {
            $entry['exception'] = ['type' => $this->clip($exception['type'], Limits::NAME), 'message' => $this->clip($exception['message'])];
        }
        $this->add($entry);
    }

    /**
     * Records an executed SQL statement and updates the database timing.
     *
     * @param array{text:string,parameters:list<array<string,mixed>>,rowsAffected?:int} $sql
     */
    public function recordSql(float $durationMs, array $sql, bool $truncated = false, ?string $category = null): void
    {
        if (!$this->active) {
            return;
        }
        $this->dbMs += $durationMs;
        $this->queries = min(PHP_INT_MAX, $this->queries + 1);
        if (!$this->hasLogRoom()) {
            return;
        }

        $this->logsTruncated = $this->logsTruncated || $truncated;
        $entry = ['level' => 'Sql', 'message' => $sql['text']];
        if ($category !== null) {
            $entry['category'] = $category;
        }
        $entry['offsetMs'] = max(0.0, $this->offsetMs() - $durationMs);
        $entry['elapsedMs'] = $durationMs;
        $entry['sql'] = $sql;
        $this->add($entry);
    }

    /** Adds time spent serialising the capture, reported as the `serialize` metric. */
    public function addSerializeMs(float $milliseconds): void
    {
        $this->serializeMs += $milliseconds;
    }

    /** @return array{0:float,1:int,2:float} database ms, query count, serialize ms */
    public function counters(): array
    {
        return [$this->dbMs, $this->queries, $this->serializeMs];
    }

    /**
     * Stops capturing and hands over what was recorded.
     *
     * @return array{effects:list<array<string,mixed>>,logs:list<array<string,mixed>>,changes:list<array<string,mixed>>,logsTruncated:bool,effectsTruncated:bool,changesTruncated:bool}
     */
    public function finish(): array
    {
        $this->active = false;
        $snapshot = [
            'effects' => $this->effects,
            'logs' => $this->logs,
            'changes' => $this->changes,
            'logsTruncated' => $this->logsTruncated,
            'effectsTruncated' => $this->effectsTruncated,
            'changesTruncated' => $this->changesTruncated,
        ];
        $this->effects = [];
        $this->logs = [];
        $this->changes = [];

        return $snapshot;
    }

    private function reset(): void
    {
        $this->effects = [];
        $this->logs = [];
        $this->changes = [];
        $this->blocked = null;
        $this->fault = null;
        $this->ended = [];
        $this->changesTruncated = false;
        $this->logsTruncated = $this->effectsTruncated = false;
        $this->logSize = $this->effectSize = $this->queries = 0;
        $this->dbMs = $this->serializeMs = 0.0;
    }

    private function offsetMs(): float
    {
        return round((hrtime(true) - $this->requestStart) / 1e6, 3);
    }

    private function clip(string $value, int $maximum = Limits::TEXT): string
    {
        $clipped = Limits::clip($value, $maximum);
        $this->logsTruncated = $this->logsTruncated || $clipped !== $value;

        return $clipped;
    }

    private function hasLogRoom(): bool
    {
        $room = count($this->logs) < Limits::LOGS && $this->logSize < Limits::LOG_BUDGET;
        $this->logsTruncated = $this->logsTruncated || !$room;

        return $room;
    }

    /** @param array<string,mixed> $entry */
    private function add(array $entry): void
    {
        $size = Limits::size($entry);
        if ($this->logSize + $size <= Limits::LOG_BUDGET) {
            $this->logs[] = $entry;
            $this->logSize += $size;
        } else {
            $this->logsTruncated = true;
        }
    }
}
