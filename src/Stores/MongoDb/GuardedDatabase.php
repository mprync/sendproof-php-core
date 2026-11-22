<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use Iterator;
use MongoDB\Builder\Pipeline;
use MongoDB\ChangeStream;
use MongoDB\Collection;
use MongoDB\Database;
use MongoDB\Driver\ClientEncryption;
use MongoDB\Driver\CursorInterface;
use MongoDB\Driver\Manager;
use MongoDB\GridFS\Bucket;

/**
 * A `MongoDB\Database` whose every command method goes through {@see MongoHook::prepare()}, and
 * whose collections are {@see GuardedCollection}s. See that class for what is and isn't covered.
 */
final class GuardedDatabase extends Database
{
    /** The methods that only read local state: they send no command and need no guard. */
    public const INERT = [
        '__construct', '__debugInfo', '__get', '__toString', 'getCollection', 'getDatabaseName', 'getManager', 'getReadConcern',
        'getReadPreference', 'getTypeMap', 'getWriteConcern', 'selectCollection', 'withOptions',
    ];

    /** A library database, guarded, with the options it was built with. */
    public static function from(Database $database, MongoHook $hook): self
    {
        return new self($database->getManager(), $database->getDatabaseName(), MongoHook::optionsOf($database), $hook);
    }

    /** @param array<string,mixed> $options */
    public function __construct(Manager $manager, string $databaseName, array $options, private readonly MongoHook $hook)
    {
        parent::__construct($manager, $databaseName, $options);
    }

    public function __get(string $collectionName): Collection
    {
        return $this->getCollection($collectionName);
    }

    public function getCollection(string $collectionName, array $options = []): Collection
    {
        return GuardedCollection::from(parent::getCollection($collectionName, $options), $this->hook);
    }

    public function selectCollection(string $collectionName, array $options = []): Collection
    {
        return $this->getCollection($collectionName, $options);
    }

    public function withOptions(array $options = []): Database
    {
        return self::from(parent::withOptions($options), $this->hook);
    }

    /** Prepares the call, then runs the library's own method with the prepared arguments. */
    private function guarded(string $method, array $args): mixed
    {
        $prepared = $this->hook->prepare(MongoHook::DATABASE, $method, $this->getDatabaseName(), $this->getDatabaseName(), $args);

        return parent::{$method}(...$prepared);
    }

    public function aggregate(array|Pipeline $pipeline, array $options = []): CursorInterface
    {
        return $this->guarded(__FUNCTION__, [$pipeline, $options]);
    }

    public function command(array|object $command, array $options = []): CursorInterface
    {
        return $this->guarded(__FUNCTION__, [$command, $options]);
    }

    public function createCollection(string $collectionName, array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$collectionName, $options]);
    }

    public function createEncryptedCollection(string $collectionName, ClientEncryption $clientEncryption, string $kmsProvider, ?array $masterKey, array $options): array
    {
        return $this->guarded(__FUNCTION__, [$collectionName, $clientEncryption, $kmsProvider, $masterKey, $options]);
    }

    public function drop(array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$options]);
    }

    public function dropCollection(string $collectionName, array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$collectionName, $options]);
    }

    public function getGridFSBucket(array $options = []): Bucket
    {
        return $this->guarded(__FUNCTION__, [$options]);
    }

    public function listCollectionNames(array $options = []): Iterator
    {
        return $this->guarded(__FUNCTION__, [$options]);
    }

    public function listCollections(array $options = []): Iterator
    {
        return $this->guarded(__FUNCTION__, [$options]);
    }

    public function modifyCollection(string $collectionName, array $collectionOptions, array $options = []): array|object
    {
        return $this->guarded(__FUNCTION__, [$collectionName, $collectionOptions, $options]);
    }

    public function renameCollection(string $fromCollectionName, string $toCollectionName, ?string $toDatabaseName = null, array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$fromCollectionName, $toCollectionName, $toDatabaseName, $options]);
    }

    public function selectGridFSBucket(array $options = []): Bucket
    {
        return $this->guarded(__FUNCTION__, [$options]);
    }

    public function watch(array|Pipeline $pipeline = [], array $options = []): ChangeStream
    {
        return $this->guarded(__FUNCTION__, [$pipeline, $options]);
    }
}
