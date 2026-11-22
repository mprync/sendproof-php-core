<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use Iterator;
use MongoDB\ChangeStream;
use MongoDB\Client;
use MongoDB\Collection;
use MongoDB\Database;
use MongoDB\Driver\BulkWriteCommand;
use MongoDB\Driver\BulkWriteCommandResult;
use MongoDB\Driver\ClientEncryption;
use MongoDB\Driver\Manager;
use MongoDB\Driver\ReadConcern;
use MongoDB\Driver\ReadPreference;
use MongoDB\Driver\Session;
use MongoDB\Driver\WriteConcern;
use MongoDB\Builder\Pipeline;
use MongoDB\ClientBulkWrite;

/**
 * Wraps a `MongoDB\Client` so every database and collection it hands out is guarded, and so a
 * session the handler starts during a Preview joins the Preview transaction.
 *
 * Handlers must use the guarded client, not the original. It has the library's own API.
 *
 * During a Preview `startSession()` returns a real session that the Preview adopts: every command
 * sent with it is moved onto the Preview's session before it is sent, so the handler's
 * `startTransaction`, `withTransaction` and `commitTransaction` run, but nothing of them reaches
 * the server, and nothing the handler writes is committed. A handler that sends a command with
 * that session outside the guarded handles (through the raw manager) escapes the Preview; the
 * tripwire then fails the Preview with 500.
 */
final class GuardedClient extends Client
{
    /** The methods that only read local state: they send no command and need no guard. */
    public const INERT = [
        '__construct', '__debugInfo', '__get', '__toString', 'createClientEncryption', 'getCollection', 'getDatabase', 'getManager',
        'getReadConcern', 'getReadPreference', 'getTypeMap', 'getWriteConcern', 'selectCollection', 'selectDatabase', 'startSession',
    ];

    public function __construct(private readonly Client $inner, private readonly MongoHook $hook)
    {
        // The inner client owns the connection. Its state is shared rather than a second manager
        // built, so the library's final methods (`addSubscriber()`, `removeSubscriber()`, which
        // laravel-mongodb's query log uses) act on the manager that really sends the commands.
        \Closure::bind(function (Client $inner): void {
            foreach (['manager', 'readConcern', 'readPreference', 'uri', 'writeConcern', 'driverOptions'] as $property) {
                $this->{$property} = $inner->{$property};
            }
        }, $this, Client::class)($inner);
    }

    /** The hook the client's handles share, which holds the engine. */
    public function hook(): MongoHook
    {
        return $this->hook;
    }

    public function __debugInfo(): array
    {
        return $this->inner->__debugInfo();
    }

    public function __get(string $databaseName): Database
    {
        return $this->getDatabase($databaseName);
    }

    public function __toString(): string
    {
        return (string) $this->inner;
    }

    public function bulkWrite(BulkWriteCommand|ClientBulkWrite $bulk, array $options = []): BulkWriteCommandResult
    {
        return $this->inner->bulkWrite($bulk, $this->prepare(__FUNCTION__, null, [$bulk, $options])[1]);
    }

    public function createClientEncryption(array $options): ClientEncryption
    {
        return $this->inner->createClientEncryption($options);
    }

    public function dropDatabase(string $databaseName, array $options = []): void
    {
        $this->inner->dropDatabase($databaseName, $this->prepare(__FUNCTION__, $databaseName, [$databaseName, $options])[1]);
    }

    public function getCollection(string $databaseName, string $collectionName, array $options = []): Collection
    {
        return GuardedCollection::from($this->inner->getCollection($databaseName, $collectionName, $options), $this->hook);
    }

    public function getDatabase(string $databaseName, array $options = []): Database
    {
        return GuardedDatabase::from($this->inner->getDatabase($databaseName, $options), $this->hook);
    }

    public function getManager(): Manager
    {
        return $this->inner->getManager();
    }

    public function getReadConcern(): ReadConcern
    {
        return $this->inner->getReadConcern();
    }

    public function getReadPreference(): ReadPreference
    {
        return $this->inner->getReadPreference();
    }

    public function getTypeMap(): array
    {
        return $this->inner->getTypeMap();
    }

    public function getWriteConcern(): WriteConcern
    {
        return $this->inner->getWriteConcern();
    }

    public function listDatabaseNames(array $options = []): Iterator
    {
        return $this->inner->listDatabaseNames($this->prepare(__FUNCTION__, null, [$options])[0]);
    }

    public function listDatabases(array $options = []): Iterator
    {
        return $this->inner->listDatabases($this->prepare(__FUNCTION__, null, [$options])[0]);
    }

    public function selectCollection(string $databaseName, string $collectionName, array $options = []): Collection
    {
        return $this->getCollection($databaseName, $collectionName, $options);
    }

    public function selectDatabase(string $databaseName, array $options = []): Database
    {
        return $this->getDatabase($databaseName, $options);
    }

    /**
     * Starts a session. During a `preview`-mode Preview it is a shell the Preview adopts (see the
     * class comment); otherwise it is the library's own session.
     */
    public function startSession(array $options = []): Session
    {
        $session = $this->inner->startSession($options);
        $state = $this->hook->engine->state();
        if ($state !== null) {
            $state->shells[$session] = false;
        }

        return $session;
    }

    public function watch(array|Pipeline $pipeline = [], array $options = []): ChangeStream
    {
        return $this->inner->watch($pipeline, $this->prepare(__FUNCTION__, null, [$pipeline, $options])[1]);
    }

    /**
     * @param list<mixed> $args
     * @return list<mixed>
     */
    private function prepare(string $method, ?string $database, array $args): array
    {
        return $this->hook->prepare(MongoHook::CLIENT, $method, null, $database, $args);
    }
}
