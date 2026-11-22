<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

use Sendproof\Core\Capture\Clock;

/**
 * Shared between a framework's dispatcher and the route marker that runs just before the handler.
 *
 * `reached` becomes true once routing, authentication and authorization let the request in, and
 * `completed` once the handler returned. Only a completed request can yield a confirmed result.
 */
final class PreviewState
{
    public bool $reached = false;
    public bool $completed = false;
    public ?string $owner = null;
    public readonly Clock $clock;

    public function __construct(int $startedNs)
    {
        $this->clock = new Clock($startedNs);
    }
}
