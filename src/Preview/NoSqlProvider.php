<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

use Sendproof\Core\Contracts\PreviewObservation;
use Sendproof\Core\Contracts\PreviewProvider;
use Sendproof\Core\Contracts\PreviewSession;

/**
 * Stands in for the SQL provider when an application registers data stores but has no SQL
 * database to roll back. The stores still abort their own transactions and block writes, so a
 * MongoDB-only or guard-only application can Preview. A SQL database with no provider is then not
 * covered, like any unhooked client.
 */
final class NoSqlProvider implements PreviewProvider
{
    public function isAvailable(): bool
    {
        return true;
    }

    public function database(): ?string
    {
        return null;
    }

    public function begin(mixed $context): PreviewSession
    {
        return new class implements PreviewSession {
            public function changes(): array
            {
                return [];
            }

            public function changesTruncated(): bool
            {
                return false;
            }

            public function rollback(): void
            {
            }

            public function dispose(): void
            {
            }
        };
    }

    public function beginObservation(mixed $context): ?PreviewObservation
    {
        return new class implements PreviewObservation {
            public function changes(): array
            {
                return [];
            }

            public function changesTruncated(): bool
            {
                return false;
            }

            public function dispose(): void
            {
            }
        };
    }
}
