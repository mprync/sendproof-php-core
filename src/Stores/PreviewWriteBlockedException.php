<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

/**
 * Thrown to the handler when the guard refuses a write during a Preview. No byte of the command
 * reached the store. The Preview answers 409 whatever the handler makes of this exception: the
 * mark the guard left on the request, not the handler's response, decides the outcome.
 */
final class PreviewWriteBlockedException extends \RuntimeException
{
    public function __construct(
        /** Store id, such as `redis`. */
        public readonly string $store,
        /** The refused command or action name, never its arguments. */
        public readonly string $operation,
        string $detail,
    ) {
        parent::__construct($detail);
    }
}
