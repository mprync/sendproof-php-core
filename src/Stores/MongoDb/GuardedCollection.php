<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use Iterator;
use MongoDB\BulkWriteResult;
use MongoDB\ChangeStream;
use MongoDB\Builder\Pipeline;
use MongoDB\Collection;
use MongoDB\DeleteResult;
use MongoDB\Driver\CursorInterface;
use MongoDB\InsertManyResult;
use MongoDB\InsertOneResult;
use MongoDB\Model\IndexInfo;
use MongoDB\Operation\Explainable;
use MongoDB\UpdateResult;

/**
 * A `MongoDB\Collection` whose every command method goes through {@see MongoHook::prepare()}.
 *
 * Handlers get it from a guarded client or database (or from the Laravel connection). It has the
 * library's own API, so application code does not change. A method added to the library after the
 * version this class was written against is not guarded: the Preview tripwire catches the write
 * and fails the Preview with 500, and a unit test fails when the library grows an unlisted method.
 */
final class GuardedCollection extends Collection
{
    /** The methods that only read local state: they send no command and need no guard. */
    public const INERT = [
        '__construct', '__debugInfo', '__toString', 'getBuilderEncoder', 'getCodec', 'getCollectionName', 'getDatabaseName', 'getManager',
        'getNamespace', 'getReadConcern', 'getReadPreference', 'getTypeMap', 'getWriteConcern', 'withOptions',
    ];

    /** A library collection, guarded, with the options it was built with. */
    public static function from(Collection $collection, MongoHook $hook): self
    {
        return new self($collection->getManager(), $collection->getDatabaseName(), $collection->getCollectionName(), MongoHook::optionsOf($collection), $hook);
    }

    /** @param array<string,mixed> $options */
    public function __construct(\MongoDB\Driver\Manager $manager, string $databaseName, string $collectionName, array $options, private readonly MongoHook $hook)
    {
        parent::__construct($manager, $databaseName, $collectionName, $options);
    }

    public function withOptions(array $options = []): Collection
    {
        return self::from(parent::withOptions($options), $this->hook);
    }

    /** Prepares the call, then runs the library's own method with the prepared arguments. */
    private function guarded(string $method, array $args): mixed
    {
        $prepared = $this->hook->prepare(MongoHook::COLLECTION, $method, $this->getCollectionName(), $this->getDatabaseName(), $args);

        return parent::{$method}(...$prepared);
    }

    public function aggregate(array|Pipeline $pipeline, array $options = []): CursorInterface
    {
        return $this->guarded(__FUNCTION__, [$pipeline, $options]);
    }

    public function bulkWrite(array $operations, array $options = []): BulkWriteResult
    {
        return $this->guarded(__FUNCTION__, [$operations, $options]);
    }

    public function count(array|object $filter = [], array $options = []): int
    {
        return $this->guarded(__FUNCTION__, [$filter, $options]);
    }

    public function countDocuments(array|object $filter = [], array $options = []): int
    {
        return $this->guarded(__FUNCTION__, [$filter, $options]);
    }

    public function createIndex(array|object $key, array $options = []): string
    {
        return $this->guarded(__FUNCTION__, [$key, $options]);
    }

    public function createIndexes(array $indexes, array $options = []): array
    {
        return $this->guarded(__FUNCTION__, [$indexes, $options]);
    }

    public function createSearchIndex(array|object $definition, array $options = []): string
    {
        return $this->guarded(__FUNCTION__, [$definition, $options]);
    }

    public function createSearchIndexes(array $indexes, array $options = []): array
    {
        return $this->guarded(__FUNCTION__, [$indexes, $options]);
    }

    public function deleteMany(array|object $filter, array $options = []): DeleteResult
    {
        return $this->guarded(__FUNCTION__, [$filter, $options]);
    }

    public function deleteOne(array|object $filter, array $options = []): DeleteResult
    {
        return $this->guarded(__FUNCTION__, [$filter, $options]);
    }

    public function distinct(string $fieldName, array|object $filter = [], array $options = []): array
    {
        return $this->guarded(__FUNCTION__, [$fieldName, $filter, $options]);
    }

    public function drop(array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$options]);
    }

    public function dropIndex(string|IndexInfo $indexName, array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$indexName, $options]);
    }

    public function dropIndexes(array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$options]);
    }

    public function dropSearchIndex(string $name, array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$name, $options]);
    }

    public function estimatedDocumentCount(array $options = []): int
    {
        return $this->guarded(__FUNCTION__, [$options]);
    }

    public function explain(Explainable $explainable, array $options = []): array|object
    {
        return $this->guarded(__FUNCTION__, [$explainable, $options]);
    }

    public function find(array|object $filter = [], array $options = []): CursorInterface
    {
        return $this->guarded(__FUNCTION__, [$filter, $options]);
    }

    public function findOne(array|object $filter = [], array $options = []): array|object|null
    {
        return $this->guarded(__FUNCTION__, [$filter, $options]);
    }

    public function findOneAndDelete(array|object $filter, array $options = []): array|object|null
    {
        return $this->guarded(__FUNCTION__, [$filter, $options]);
    }

    public function findOneAndReplace(array|object $filter, array|object $replacement, array $options = []): array|object|null
    {
        return $this->guarded(__FUNCTION__, [$filter, $replacement, $options]);
    }

    public function findOneAndUpdate(array|object $filter, array|object $update, array $options = []): array|object|null
    {
        return $this->guarded(__FUNCTION__, [$filter, $update, $options]);
    }

    public function insertMany(array $documents, array $options = []): InsertManyResult
    {
        return $this->guarded(__FUNCTION__, [$documents, $options]);
    }

    public function insertOne(array|object $document, array $options = []): InsertOneResult
    {
        return $this->guarded(__FUNCTION__, [$document, $options]);
    }

    public function listIndexes(array $options = []): Iterator
    {
        return $this->guarded(__FUNCTION__, [$options]);
    }

    public function listSearchIndexes(array $options = []): Iterator
    {
        return $this->guarded(__FUNCTION__, [$options]);
    }

    public function rename(string $toCollectionName, ?string $toDatabaseName = null, array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$toCollectionName, $toDatabaseName, $options]);
    }

    public function replaceOne(array|object $filter, array|object $replacement, array $options = []): UpdateResult
    {
        return $this->guarded(__FUNCTION__, [$filter, $replacement, $options]);
    }

    public function updateMany(array|object $filter, array|object $update, array $options = []): UpdateResult
    {
        return $this->guarded(__FUNCTION__, [$filter, $update, $options]);
    }

    public function updateOne(array|object $filter, array|object $update, array $options = []): UpdateResult
    {
        return $this->guarded(__FUNCTION__, [$filter, $update, $options]);
    }

    public function updateSearchIndex(string $name, array|object $definition, array $options = []): void
    {
        $this->guarded(__FUNCTION__, [$name, $definition, $options]);
    }

    public function watch(array|Pipeline $pipeline = [], array $options = []): ChangeStream
    {
        return $this->guarded(__FUNCTION__, [$pipeline, $options]);
    }
}
