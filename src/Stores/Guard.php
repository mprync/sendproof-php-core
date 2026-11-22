<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

use Closure;
use Sendproof\Core\Capture\Recorder;

/**
 * The write guard of spec/data-stores.md: the single decision point every store hook calls before
 * it sends a command, plus the helpers hooks share for logging and redaction.
 *
 * Outside a Preview the guard does nothing, so Send and observed Send are never blocked. In a
 * Preview it records the first refused write on the request's {@see Recorder} and throws
 * {@see PreviewWriteBlockedException}. The recorder's mark, not the handler's response, decides the
 * outcome: a handler that catches the exception and returns 200 still produces a 409.
 *
 * Hooks live as long as their client, which can outlive a request (Octane, workers), so the guard
 * resolves the request's recorder on every call through the closure it was given.
 */
final class Guard
{
    /** Display names used in "Preview unavailable: this operation writes to <Store>". */
    public const STORE_NAMES = [
        'mongodb' => 'MongoDB', 'redis' => 'Redis', 'dynamodb' => 'DynamoDB',
        'cassandra' => 'Cassandra', 'elasticsearch' => 'Elasticsearch', 'opensearch' => 'OpenSearch', 'cosmosdb' => 'Cosmos DB', 'firestore' => 'Firestore',
    ];

    /** @param Closure(): Recorder $recorder Resolves the current request's recorder */
    public function __construct(private readonly Closure $recorder)
    {
    }

    /** The current request's recorder. */
    public function recorder(): Recorder
    {
        return ($this->recorder)();
    }

    /** Whether this request belongs to a Preview, including after the Preview finished. */
    public function inPreview(): bool
    {
        return $this->recorder()->inPreviewScope();
    }

    /** The display name of a store id; unknown ids are shown as given. */
    public static function storeName(string $store): string
    {
        return self::STORE_NAMES[$store] ?? $store;
    }

    /** The reason shown for a write to a guarded store. */
    public static function writeReason(string $store): string
    {
        return 'Preview unavailable: this operation writes to ' . self::storeName($store);
    }

    /**
     * Call before sending a store command. Does nothing outside a Preview or for anything but a
     * write. In a Preview it marks the recorder blocked (the first block wins), logs a blocked `Db`
     * entry and throws. `$detail` replaces the default "writes to <Store>" reason, for example for a
     * MongoDB command that can't run inside a transaction.
     *
     * @throws PreviewWriteBlockedException
     */
    public function guard(string $store, string $operation, CommandKind $kind, ?string $detail = null): void
    {
        if ($kind !== CommandKind::Write) {
            return;
        }
        $recorder = $this->recorder();
        if (!$recorder->inPreviewScope()) {
            return;
        }
        $reason = $detail ?? self::writeReason($store);
        $recorder->block(['store' => $store, 'operation' => $operation, 'detail' => $reason]);
        $recorder->db(['system' => $store, 'operation' => $operation, 'blocked' => true]);

        throw new PreviewWriteBlockedException($store, $operation, $reason);
    }

    /**
     * Refuses something that would end or escape the Preview transaction. Records the fault on the
     * current Preview, so the Preview fails with 500 even if the handler catches the exception, and
     * returns it for the caller to throw. Outside a Preview it returns null.
     */
    public function refuse(string $message): ?PreviewTransactionControlException
    {
        $recorder = $this->recorder();
        if (!$recorder->inPreviewScope()) {
            return null;
        }
        $error = new PreviewTransactionControlException($message);
        $recorder->refuse($error);

        return $error;
    }

    /**
     * Replaces every literal in a command document with `"?"`, keeping field names and operators,
     * for the `statement` of a MongoDB `Db` entry (OpenTelemetry `db.query.text`). BSON values,
     * dates and binary data are literals too.
     */
    public static function sanitizeDocument(mixed $value): mixed
    {
        if ($value instanceof \MongoDB\BSON\Document || $value instanceof \MongoDB\BSON\PackedArray) {
            $value = $value->toPHP(['root' => 'array', 'document' => 'array', 'array' => 'array']);
        }
        if ($value instanceof \MongoDB\BSON\Serializable && !$value instanceof \ArrayObject) {
            $value = $value->bsonSerialize();
        }
        if ($value instanceof \ArrayObject) {
            $value = $value->getArrayCopy();
        }
        if ($value instanceof \stdClass) {
            return array_map(self::sanitizeDocument(...), (array) $value) ?: new \stdClass();
        }
        if (is_array($value)) {
            return array_map(self::sanitizeDocument(...), $value);
        }

        return '?';
    }

    /**
     * Validates the optional label a host gives a store for capabilities `dataStores`. Discovery is
     * shown to anyone who can open the workbench, so the label must be a display name such as
     * `catalog`: never a connection string, URL, host:port, user or password.
     *
     * @throws \InvalidArgumentException
     */
    public static function storeLabel(mixed $name): ?string
    {
        if ($name === null) {
            return null;
        }
        if (!is_string($name) || trim($name) === '' || mb_strlen($name) > 64 || preg_match('/[\p{Cc}\/\\\\@=;:?#%]/u', $name) === 1) {
            throw new \InvalidArgumentException('A data store name must be a display label such as "catalog", not a connection string, URL or host.');
        }

        return $name;
    }

    /**
     * Normalises host-declared reads ("treat as read") into an exact-match set, after `$transform`.
     *
     * @param list<string>|null $names
     * @param callable(string): string|null $transform
     * @return array<string,true>|null
     */
    public static function readSet(?array $names, ?callable $transform = null): ?array
    {
        if ($names === null) {
            return null;
        }
        $set = [];
        foreach ($names as $name) {
            if (!is_string($name) || $name === '' || preg_match('/[*?\s]/', $name) === 1) {
                throw new \InvalidArgumentException('treat_as_read takes exact command names, without wildcards.');
            }
            $set[$transform === null ? $name : $transform($name)] = true;
        }

        return $set;
    }
}
