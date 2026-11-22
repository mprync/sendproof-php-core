<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Redis;

use Predis\Client;
use Predis\Connection\AggregateConnectionInterface;
use Predis\Connection\ConnectionInterface;
use Predis\Connection\FactoryInterface;
use Predis\Connection\NodeConnectionInterface;

/**
 * Hooks a Predis client in place (spec/data-stores.md, `guard` mode).
 *
 * Two layers, both run before a byte is written:
 *
 * - a command processor on the client's command factory, which sees every command a pipeline or
 *   transaction callback queues, so a refused write stops the whole batch before `EXEC`;
 * - a connection decorator on every node connection, which sees `executeRaw()`, hand-built
 *   commands and pub/sub.
 *
 * A cluster or replication client (`cluster`, `replication`, Sentinel) keeps its own connection
 * class, which pipelines and transactions depend on; the decorator goes on each node inside it
 * instead, and on the factory it creates new nodes with, so a node discovered later is guarded too.
 */
final class PredisGuard
{
    /** @var \WeakMap<Client,true>|null */
    private static ?\WeakMap $hooked = null;

    /** Hooks `$client`. Hooking the same client twice is a no-op, so its commands are never logged twice. */
    public static function install(Client $client, RedisHook $hook): void
    {
        self::$hooked ??= new \WeakMap();
        if (isset(self::$hooked[$client])) {
            return;
        }
        self::$hooked[$client] = true;

        $factory = $client->getCommandFactory();
        $factory->setProcessor(new PredisGuardProcessor($hook, $factory->getProcessor()));

        $connection = $client->getConnection();
        if ($connection instanceof AggregateConnectionInterface) {
            self::guardAggregate($connection, $hook);

            return;
        }
        if (!$connection instanceof NodeConnectionInterface) {
            throw new \InvalidArgumentException('Sendproof cannot guard a Predis client whose connection is neither a node nor a cluster or replication connection.');
        }
        // Client::$connection is protected and the client has no setter, so rebind it from inside.
        \Closure::bind(function (ConnectionInterface $guarded): void {
            $this->connection = $guarded;
        }, $client, Client::class)(new GuardedPredisConnection($connection, $hook));
    }

    /**
     * Guards the node connections an aggregate already holds (re-added through its own `remove()`
     * and `add()`, so its slot, alias and role bookkeeping stays right) and the factory it creates
     * new nodes with. Predis keeps both in non-public properties, which are found by type.
     */
    private static function guardAggregate(AggregateConnectionInterface $aggregate, RedisHook $hook): void
    {
        $nodes = [];
        for ($class = new \ReflectionClass($aggregate); $class !== false; $class = $class->getParentClass()) {
            foreach ($class->getProperties() as $property) {
                if ($property->isStatic() || !$property->isInitialized($aggregate)) {
                    continue;
                }
                $value = $property->getValue($aggregate);
                if ($value instanceof FactoryInterface && !$value instanceof GuardedPredisFactory) {
                    $property->setValue($aggregate, new GuardedPredisFactory($value, $hook));
                } elseif ($property->getName() === 'pool' && is_array($value)) {
                    $nodes = [...$nodes, ...array_values($value)];
                } elseif ($value instanceof NodeConnectionInterface) {
                    $nodes[] = $value;
                }
            }
        }
        $seen = new \SplObjectStorage();
        foreach ($nodes as $node) {
            if (!$node instanceof NodeConnectionInterface || $node instanceof GuardedPredisConnection || $seen->contains($node)) {
                continue;
            }
            $seen->attach($node);
            if ($aggregate->remove($node)) {
                $aggregate->add(new GuardedPredisConnection($node, $hook, true));
            }
        }
    }
}
