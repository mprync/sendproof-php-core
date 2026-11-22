<?php

declare(strict_types=1);

namespace Sendproof\Core\Contracts;

/**
 * Implemented by a preview provider that knows which SQL database it serves, so discovery names
 * the provider (`sqlite`, `postgresql`, `mysql`, `mariadb`, `sqlserver`) and the workbench shows
 * that provider's mark instead of guessing from the database name.
 */
interface DescribesDatabaseSystem
{
    /** The SQL provider id, or null when it cannot be told. */
    public function databaseSystem(): ?string;
}
