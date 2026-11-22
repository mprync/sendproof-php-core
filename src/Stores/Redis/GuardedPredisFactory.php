<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Redis;

use Predis\Connection\FactoryInterface;

/**
 * A Predis connection factory whose every connection is a {@see GuardedPredisConnection}.
 *
 * Cluster and replication connections create node connections as they discover them (a slot moved
 * to a new node, a replica found through `INFO`, a master named by Sentinel). {@see PredisGuard}
 * puts this factory in the aggregate's place, so every node it creates after the hook is guarded.
 *
 * @internal Installed by {@see PredisGuard::install()}
 */
final class GuardedPredisFactory implements FactoryInterface
{
    public function __construct(private readonly FactoryInterface $inner, private readonly RedisHook $hook)
    {
    }

    public function define($scheme, $initializer)
    {
        $this->inner->define($scheme, $initializer);
    }

    public function undefine($scheme)
    {
        $this->inner->undefine($scheme);
    }

    public function create($parameters)
    {
        $connection = $this->inner->create($parameters);

        return $connection instanceof GuardedPredisConnection ? $connection : new GuardedPredisConnection($connection, $this->hook, true);
    }

    /** Anything else the wrapped factory offers (default parameters, Relay settings) passes through. */
    public function __call(string $method, array $arguments): mixed
    {
        return $this->inner->{$method}(...$arguments);
    }
}
