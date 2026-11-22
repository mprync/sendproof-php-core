<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Redis;

use Predis\Command\CommandInterface;
use Predis\Command\Processor\ProcessorInterface;

/**
 * A Predis command processor that runs the write guard when a command is created. Predis creates
 * every command a pipeline or transaction callback queues through the client's command factory,
 * so a refused write throws inside the callback, before the batch (and before `EXEC`) is written.
 */
final class PredisGuardProcessor implements ProcessorInterface
{
    public function __construct(private readonly RedisHook $hook, private readonly ?ProcessorInterface $next = null)
    {
    }

    public function process(CommandInterface $command): void
    {
        $this->hook->check($command->getId(), array_values($command->getArguments()));
        $this->next?->process($command);
    }
}
