<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Stores\DataStore;
use Sendproof\Core\Stores\Guard;

/**
 * A hooked MongoDB client, ready to register with the Preview runner and discovery.
 *
 * On a replica set or sharded cluster a Preview runs every command in one transaction that is
 * aborted after the handler, and reports document changes. On a standalone server MongoDB can't
 * run transactions, so the store runs in `guard` mode like Redis: reads run and the first write
 * blocks the Preview.
 */
final class MongoStore implements DataStore
{
    public function __construct(public readonly MongoEngine $engine, private readonly ?string $name = null, private readonly ?GuardedClient $client = null)
    {
    }

    /**
     * Hooks a `MongoDB\Client` for an application that uses the library directly: handlers must use
     * the returned store's {@see client()}, which has the library's own API and adds the Preview
     * session during a Preview. The original client stays unguarded.
     *
     * @param array<string,true>|null $reads Host-declared reads, lower-case names; see {@see Guard::readSet()}
     * @param int $timeoutMs How long a Preview may hold its transaction, below the server's 60 seconds
     */
    public static function hook(\MongoDB\Client $client, Guard $guard, ?string $name = null, ?array $reads = null, int $timeoutMs = MongoEngine::DEFAULT_TIMEOUT_MS): self
    {
        $engine = new MongoEngine($client->getManager(), $guard, $reads, $timeoutMs);

        return new self($engine, Guard::storeLabel($name), new GuardedClient($client, new MongoHook($engine)));
    }

    /** The guarded client handlers must use. */
    public function client(): GuardedClient
    {
        return $this->client ?? throw new \LogicException('This store was built around an existing engine; use its own guarded client.');
    }

    public function system(): string
    {
        return 'mongodb';
    }

    public function describe(): array
    {
        return ['system' => 'mongodb'] + ($this->name === null ? [] : ['name' => $this->name]) + $this->engine->detect();
    }

    public function begin(Recorder $recorder): void
    {
        $this->engine->begin($recorder);
    }

    public function finish(Recorder $recorder): void
    {
        $this->engine->finish($recorder);
    }
}
