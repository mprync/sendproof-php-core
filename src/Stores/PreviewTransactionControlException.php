<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

/**
 * Thrown when a handler tries to end or escape the Preview transaction: a raw SQL `COMMIT`, a
 * MongoDB `commitTransaction`, or a store command sent with a session other than the Preview's.
 * The Preview answers 500 without confirmation even if the handler catches this exception.
 */
final class PreviewTransactionControlException extends \RuntimeException
{
}
