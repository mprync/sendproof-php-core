<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\MongoDb;

use MongoDB\Driver\Monitoring\CommandFailedEvent;
use MongoDB\Driver\Monitoring\CommandStartedEvent;
use MongoDB\Driver\Monitoring\CommandSubscriber;
use MongoDB\Driver\Monitoring\CommandSucceededEvent;

/**
 * The driver's command-monitoring subscriber for one client. It forwards every command to the
 * engine, which uses it for the tripwire, the `Db` log and change candidates.
 *
 * @internal
 */
final class MongoMonitor implements CommandSubscriber
{
    public function __construct(private readonly MongoEngine $engine)
    {
    }

    public function commandStarted(CommandStartedEvent $event): void
    {
        $this->engine->started($event);
    }

    public function commandSucceeded(CommandSucceededEvent $event): void
    {
        $this->engine->succeeded($event);
    }

    public function commandFailed(CommandFailedEvent $event): void
    {
        $this->engine->failed($event);
    }
}
