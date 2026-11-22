<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use MongoDB\Builder\BuilderEncoder;
use MongoDB\Builder\Pipeline;
use MongoDB\Collection;
use MongoDB\Database;
use MongoDB\Driver\Session;
use Sendproof\Core\Stores\Classifier;
use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\PreviewTransactionControlException;

/**
 * Prepares every call a guarded MongoDB handle makes. No MongoDB driver offers a pre-send hook, so
 * the guarded client, database and collection call {@see prepare()} before they hand a call to the
 * library. During a Preview it:
 *
 * - classifies the command the method sends and lets the guard block writes (`guard` mode) or what
 *   a transaction can't run (`preview` mode);
 * - adds the Preview session to the call's options, so the command carries the Preview's `lsid`,
 *   `txnNumber` and `autocommit: false`;
 * - swaps a session the handler created through the guarded client for the Preview session, so the
 *   handler's own transaction joins the Preview's;
 * - refuses any other explicit session, which would send the command outside the Preview.
 *
 * Outside a Preview every call passes straight through.
 */
final class MongoHook
{
    public const COLLECTION = 'collection';
    public const DATABASE = 'database';
    public const CLIENT = 'client';

    /**
     * Methods refused in every Preview, whatever the mode. A GridFS bucket builds its own
     * collections around the driver's manager and takes no session, so its uploads would commit
     * outside the Preview transaction (and outside the guard): the bucket is refused before any
     * command is sent.
     */
    private const REFUSED = [
        'getGridFSBucket' => "Preview unavailable: MongoDB GridFS can't join the Preview transaction",
        'selectGridFSBucket' => "Preview unavailable: MongoDB GridFS can't join the Preview transaction",
    ];

    /** @var array<string,array<string,array{0:\Closure,1:int,2?:mixed}>>|null */
    private static ?array $rules = null;

    public function __construct(public readonly MongoEngine $engine)
    {
    }

    /**
     * @param self::COLLECTION|self::DATABASE|self::CLIENT $scope
     * @param string|null $name The collection name (collection scope) or database name (database scope)
     * @param string|null $database The database the call addresses, when it names one
     * @param list<mixed> $args The call's arguments
     * @return list<mixed> The arguments to hand to the library
     * @throws \Sendproof\Core\Stores\PreviewWriteBlockedException
     * @throws PreviewTransactionControlException
     */
    public function prepare(string $scope, string $method, ?string $name, ?string $database, array $args): array
    {
        $guard = $this->engine->guard;
        if (!$guard->inPreview()) {
            return $args;
        }
        if (isset(self::REFUSED[$method])) {
            // In both modes: nothing the call leads to could carry the Preview session.
            $guard->guard('mongodb', $method, CommandKind::Write, self::REFUSED[$method]);
        }
        $rule = (self::rules()[$scope][$method] ?? null);
        if ($rule === null) {
            // A method this guard doesn't know: refuse it in a Preview rather than let it escape.
            $guard->guard('mongodb', $method, CommandKind::Write, MongoEngine::refusedReason($method));
        }
        [$command, $index] = $rule;
        $document = $command((string) $name, $args);
        $operation = (string) (array_key_first($document) ?? $method);
        $this->engine->check($document, $operation, $database);
        $state = $this->engine->state();
        if ($state === null || MongoEngine::systemDatabase($database)) {
            return $args;
        }

        $options = $args[$index] ?? [];
        $given = is_array($options) ? ($options['session'] ?? null) : null;
        if ($given instanceof Session && $given !== $state->session && !isset($state->shells[$given])) {
            throw $guard->refuse('A MongoDB call passed its own session during a Preview; the Preview session must carry every command.')
                ?? new PreviewTransactionControlException('A MongoDB call passed its own session during a Preview.');
        }
        if ($given instanceof Session && isset($state->shells[$given])) {
            // The handler's session is a shell: its command moves onto the Preview's transaction.
            $state->shells[$given] = true;
        }
        while (count($args) < $index) {
            $args[] = $rule[2] ?? [];
        }
        $args[$index] = [...(is_array($options) ? $options : []), 'session' => $state->session];

        return $args;
    }

    /**
     * The collection, database and client methods that send commands: the command each sends (its
     * first key is the command name) and the position of its options argument. A third element
     * pads missing optional arguments before the options; it is `[]` unless given.
     *
     * @return array<string,array<string,array{0:\Closure,1:int,2?:mixed}>>
     */
    private static function rules(): array
    {
        if (self::$rules !== null) {
            return self::$rules;
        }
        $simple = static fn (string $command, int $options, mixed $pad = []): array => [static fn (string $name): array => [$command => $name], $options, $pad];
        $aggregate = static fn (int $options): array => [static fn (string $name, array $args): array => ['aggregate' => $name, 'pipeline' => self::pipeline($args[0] ?? [])], $options];
        $stage = static fn (string $stage, int $options): array => [static fn (string $name, array $args): array => ['aggregate' => $name, 'pipeline' => [[$stage => []], ...self::pipeline($args[0] ?? [])]], $options];
        $one = static fn (string $command, int $options): array => [static fn (string $name): array => [$command => 1], $options];

        return self::$rules = [
            self::COLLECTION => [
                'insertOne' => $simple('insert', 1), 'insertMany' => $simple('insert', 1), 'bulkWrite' => $simple('bulkWrite', 1),
                'updateOne' => $simple('update', 2), 'updateMany' => $simple('update', 2), 'replaceOne' => $simple('update', 2),
                'deleteOne' => $simple('delete', 1), 'deleteMany' => $simple('delete', 1),
                'find' => $simple('find', 1), 'findOne' => $simple('find', 1), 'countDocuments' => $aggregate(1), 'distinct' => $simple('distinct', 2),
                'findOneAndDelete' => $simple('findAndModify', 1), 'findOneAndReplace' => $simple('findAndModify', 2), 'findOneAndUpdate' => $simple('findAndModify', 2),
                'aggregate' => $aggregate(1), 'estimatedDocumentCount' => $simple('count', 0), 'count' => $simple('count', 1),
                'rename' => $simple('renameCollection', 2, null), 'drop' => $simple('drop', 0),
                'createIndex' => $simple('createIndexes', 1), 'createIndexes' => $simple('createIndexes', 1),
                'dropIndex' => $simple('dropIndexes', 1), 'dropIndexes' => $simple('dropIndexes', 0), 'listIndexes' => $simple('listIndexes', 0),
                'createSearchIndex' => $simple('createSearchIndexes', 1), 'createSearchIndexes' => $simple('createSearchIndexes', 1),
                'dropSearchIndex' => $simple('dropSearchIndexes', 1), 'updateSearchIndex' => $simple('updateSearchIndex', 2),
                'listSearchIndexes' => [static fn (string $name): array => ['aggregate' => $name, 'pipeline' => [['$listSearchIndexes' => new \stdClass()]]], 0],
                'explain' => [static fn (string $name, array $args): array => ['explain' => $args[0] instanceof \MongoDB\Operation\Explainable ? $args[0]->getCommandDocument() : ['unknown' => 1]], 1],
                'watch' => [static fn (string $name, array $args): array => ['aggregate' => $name, 'pipeline' => [['$changeStream' => new \stdClass()], ...self::pipeline($args[0] ?? [])]], 1],
            ],
            self::DATABASE => [
                'aggregate' => [static fn (string $name, array $args): array => ['aggregate' => 1, 'pipeline' => self::pipeline($args[0] ?? [])], 1],
                'command' => [static fn (string $name, array $args): array => Classifier::asArray($args[0] ?? []) ?? [], 1],
                'createCollection' => [static fn (string $name, array $args): array => ['create' => $args[0] ?? ''], 1],
                'createEncryptedCollection' => [static fn (string $name, array $args): array => ['create' => $args[0] ?? ''], 4],
                'drop' => $one('dropDatabase', 0),
                'dropCollection' => [static fn (string $name, array $args): array => ['drop' => $args[0] ?? ''], 1],
                'listCollectionNames' => $one('listCollections', 0), 'listCollections' => $one('listCollections', 0),
                'modifyCollection' => [static fn (string $name, array $args): array => ['collMod' => $args[0] ?? ''], 2],
                'renameCollection' => [static fn (string $name, array $args): array => ['renameCollection' => $args[0] ?? ''], 3, null],
                'watch' => [static fn (string $name, array $args): array => ['aggregate' => 1, 'pipeline' => [['$changeStream' => new \stdClass()], ...self::pipeline($args[0] ?? [])]], 1],
            ],
            self::CLIENT => [
                'bulkWrite' => $one('bulkWrite', 1), 'dropDatabase' => $one('dropDatabase', 1),
                'listDatabaseNames' => $one('listDatabases', 0), 'listDatabases' => $one('listDatabases', 0),
                'watch' => [static fn (string $name, array $args): array => ['aggregate' => 1, 'pipeline' => [['$changeStream' => new \stdClass()], ...self::pipeline($args[0] ?? [])]], 1],
            ],
        ];
    }

    /**
     * The stages of an aggregation pipeline as a plain list, so the classifier can search them.
     * A builder `Pipeline` is encoded first; one that can't be read counts as a `$out`, which fails closed.
     *
     * @return list<mixed>
     */
    public static function pipeline(mixed $pipeline): array
    {
        if ($pipeline instanceof Pipeline) {
            try {
                $encoded = (new BuilderEncoder())->encodeIfSupported($pipeline);

                return is_array($encoded) ? array_values($encoded) : [['$out' => '?']];
            } catch (\Throwable) {
                return [['$out' => '?']];
            }
        }

        return is_array($pipeline) ? array_values($pipeline) : [['$out' => '?']];
    }

    /**
     * The constructor options of a library handle, read back so a guarded copy behaves the same.
     *
     * @return array<string,mixed>
     */
    public static function optionsOf(Collection|Database $handle): array
    {
        $options = [];
        $class = $handle instanceof Collection ? Collection::class : Database::class;
        foreach (['builderEncoder', 'codec', 'readConcern', 'readPreference', 'typeMap', 'writeConcern', 'autoEncryptionEnabled'] as $name) {
            if (!property_exists($class, $name)) {
                continue;
            }
            $property = new \ReflectionProperty($class, $name);
            $value = $property->getValue($handle);
            if ($value !== null) {
                $options[$name] = $value;
            }
        }

        return $options;
    }
}
