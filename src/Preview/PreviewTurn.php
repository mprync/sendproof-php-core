<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

/**
 * One Preview's turn on a database, held until {@see release()} or until the object is destroyed.
 *
 * MySQL and MariaDB deadlock (error 1213) when three or more transactions insert the same new key
 * and the first rolls back, as every Preview does, at every isolation level. Previews on such a
 * database therefore take turns. See {@see PreviewTurns}.
 */
final class PreviewTurn
{
    /** @param string $path The lock file this turn holds; {@see PreviewTurns} owns the lock itself */
    public function __construct(private ?string $path)
    {
    }

    /** Hands the turn to the next waiting Preview. Safe to call more than once. */
    public function release(): void
    {
        if ($this->path === null) {
            return;
        }
        $path = $this->path;
        $this->path = null;
        PreviewTurns::giveBack($path);
    }

    public function __destruct()
    {
        $this->release();
    }
}
