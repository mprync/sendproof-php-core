<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

use Sendproof\Core\Capture\Clock;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Contracts\PreviewProvider;
use Sendproof\Core\Limits;
use Sendproof\Core\Stores\DataStore;
use Sendproof\Core\Stores\PreviewWriteBlockedException;

/**
 * Runs one operation inside a rollback-only session and builds the confirmed envelope.
 *
 * The runner always rolls back and disposes the session. It confirms only when the handler was
 * reached and returned, the response fits the cap, and rollback succeeded. Anything else becomes
 * a rejection, so an unconfirmed result is never presented as a rollback.
 */
final class PreviewRunner
{
    private const PRIVATE_HEADERS = ['set-cookie', 'location', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'trailer'];

    /**
     * @param callable(\Throwable): void $report Receives failures for the host's own logging
     */
    public function __construct(private readonly Recorder $recorder, private $report = null)
    {
    }

    /**
     * Pipeline order (spec/data-stores.md): run the handler; end every `preview`-mode store
     * transaction (capturing its changes first); roll back SQL. A failed store, a failed rollback
     * or a recorded fault answers 500; otherwise a blocked write answers 409; otherwise the
     * Preview is confirmed. The recorder's marks decide, never the handler's response.
     *
     * @param callable(): CapturedResponse $dispatch Dispatches the rewritten request through the real framework
     * @param list<DataStore> $stores The hooked data stores, in registration order
     */
    public function run(PreviewProvider $provider, PreviewState $state, callable $dispatch, mixed $context, array $stores = []): PreviewResult
    {
        $failure = null;
        $envelope = null;
        $response = null;
        $session = null;
        /** A store that could not end, or a fault recorded during the Preview: never confirmed, never 409. */
        $unsafe = false;

        try {
            $session = $provider->begin($context);
            $this->recorder->begin(true, $state->clock->start());
            try {
                foreach ($stores as $store) {
                    $store->begin($this->recorder);
                }
                $response = $dispatch();
            } catch (\Throwable $error) {
                $failure = $error;
            }

            // Every store ends its transaction, even after a failure, so nothing stays open.
            foreach ($stores as $store) {
                try {
                    $store->finish($this->recorder);
                } catch (\Throwable $error) {
                    $unsafe = true;
                    $this->report !== null && ($this->report)($error);
                }
            }

            try {
                $session->rollback();
                $blocked = $this->recorder->blocked() !== null && self::isBlockOrNothing($failure) && self::isBlockOrNothing($response?->failure);
                if ($blocked && !$unsafe && $this->recorder->fault() === null) {
                    // The guard refused a write: the Preview is blocked, whatever the handler made of it.
                    $this->recorder->finish();
                } elseif ($failure === null && !$unsafe && $this->recorder->fault() === null && $response !== null && $response->failure === null
                    && $state->completed && strlen($response->body) <= Limits::RESPONSE_BYTES && !self::isDenied($response->status)) {
                    $started = hrtime(true);
                    $envelope = $this->envelope($response, $session->changes(), $session->changesTruncated(), $this->recorder->finish());
                    $this->recorder->addSerializeMs((hrtime(true) - $started) / 1e6);
                }
            } catch (\Throwable $error) {
                $failure = $failure === null ? $error : new \RuntimeException($failure->getMessage() . ' / ' . $error->getMessage(), 0, $error);
            } finally {
                if ($this->recorder->isCapturing()) {
                    $this->recorder->finish();
                }
                try {
                    $session->dispose();
                } catch (\Throwable $error) {
                    $failure ??= $error;
                }
            }
        } catch (\Throwable $error) {
            // The session could not begin, so nothing was run.
            $failure ??= $error;
            if ($this->recorder->isCapturing()) {
                $this->recorder->finish();
            }
        }

        if ($failure === null && $response !== null && $response->failure !== null) {
            $failure = $response->failure;
        }
        $fault = $this->recorder->fault();
        $write = $this->recorder->blocked();
        // A blocked write outranks the handler's own error, but not a failed store, a failed
        // rollback or a recorded fault.
        if ($write !== null && !$unsafe && $fault === null && self::isBlockOrNothing($failure)) {
            return PreviewResult::blocked($write);
        }
        if ($failure !== null || $unsafe || $fault !== null) {
            $failure ??= $fault;
            $failure !== null && $this->report !== null && ($this->report)($failure);

            return PreviewResult::rejected(500, 'The preview could not be completed safely.');
        }
        if ($response !== null && strlen($response->body) > Limits::RESPONSE_BYTES) {
            return PreviewResult::rejected(413, 'The preview response exceeds the 1 MiB limit.');
        }
        if ($envelope === null || $response === null) {
            return $this->unexecuted($state, $response);
        }

        [$db, $queries, $serialize] = $this->recorder->counters();
        $timing = Clock::header($state->clock->timing($db, $queries, $serialize));

        return PreviewResult::confirmed($envelope, $timing);
    }

    /**
     * Whether a handler failure is absent or is the guard's own refusal (possibly wrapped by the
     * framework). A handler that throws after a block still gets the 409; any other error means
     * the Preview did not run as the guard saw it.
     */
    private static function isBlockOrNothing(?\Throwable $failure): bool
    {
        for ($error = $failure; $error !== null; $error = $error->getPrevious()) {
            if ($error instanceof PreviewWriteBlockedException) {
                return true;
            }
        }

        return $failure === null;
    }

    /** Whether an inner status means the caller was not allowed to run the operation. */
    private static function isDenied(int $status): bool
    {
        return $status === 401 || $status === 403;
    }

    private function unexecuted(PreviewState $state, ?CapturedResponse $response): PreviewResult
    {
        $status = $response?->status ?? 500;
        if ($state->reached && !self::isDenied($status) && $response !== null && $state->completed === false) {
            return PreviewResult::rejected(500, 'The preview operation did not finish.');
        }

        $headers = [];
        if (($challenge = $response?->header('www-authenticate')) !== null) {
            $headers['WWW-Authenticate'] = $challenge;
        }

        $title = match (true) {
            $status === 401 => 'Authentication is required for this preview.',
            $status === 403 => 'This preview is forbidden.',
            $status === 404 || $status === 405 => 'The preview target was not found for this method.',
            $status === 503 => 'Preview requires one available preview provider.',
            $status >= 300 && $status < 400 => 'Preview redirects are disabled. Sign in through the workbench first.',
            $status >= 400 && $status < 500 && $status !== 409 => 'The host rejected the preview request.',
            default => 'This operation is unavailable for preview.',
        };
        if ($status < 400 || ($status >= 500 && $status !== 503)) {
            $status = $status >= 300 && $status < 400 ? 401 : 409;
        }

        return PreviewResult::rejected($status, $title, $headers);
    }

    /**
     * @param list<array<string,mixed>> $changes
     * @param array{effects:list<array<string,mixed>>,logs:list<array<string,mixed>>,changes:list<array<string,mixed>>,logsTruncated:bool,effectsTruncated:bool,changesTruncated:bool} $capture
     * @return array<string,mixed>
     */
    private function envelope(CapturedResponse $response, array $changes, bool $changesTruncated, array $capture): array
    {
        // Changes the SQL session saw come first, then document, item and key changes from the stores.
        [$snapshot, $truncated] = Limits::snapshotChanges([...$changes, ...$capture['changes']]);
        $changesTruncated = $changesTruncated || $capture['changesTruncated'];
        $headers = [];
        foreach ($response->headers as $name => $value) {
            $lower = strtolower((string) $name);
            if (in_array($lower, self::PRIVATE_HEADERS, true) || strlen($lower) > Limits::NAME) {
                continue;
            }
            if (count($headers) === Limits::PARAMETERS) {
                break;
            }
            $headers[$lower] = Limits::clip($value);
        }

        $envelope = [
            'status' => $response->status,
            'headers' => (object) $headers,
            'body' => self::body($response),
            'changes' => $snapshot,
            'effects' => $capture['effects'],
            'logs' => $capture['logs'],
            'rolledBack' => true,
        ];
        if ($truncated || $changesTruncated) {
            $envelope['changesTruncated'] = true;
        }
        if ($capture['effectsTruncated']) {
            $envelope['effectsTruncated'] = true;
        }
        if ($capture['logsTruncated']) {
            $envelope['logsTruncated'] = true;
        }

        return $envelope;
    }

    /** Decodes JSON bodies, keeps text as text and base64-encodes everything else. */
    private static function body(CapturedResponse $response): mixed
    {
        if ($response->body === '') {
            return null;
        }
        $type = strtolower(trim(explode(';', $response->header('content-type') ?? '', 2)[0]));
        if ($type === 'application/json' || str_ends_with($type, '+json')) {
            $decoded = json_decode($response->body, false, 512);
            if (json_last_error() === JSON_ERROR_NONE) {
                return $decoded;
            }

            return mb_check_encoding($response->body, 'UTF-8') ? $response->body : base64_encode($response->body);
        }

        return ($type === '' || str_starts_with($type, 'text/')) && mb_check_encoding($response->body, 'UTF-8')
            ? $response->body
            : base64_encode($response->body);
    }
}
