<?php

declare(strict_types=1);

namespace Sendproof\Core\Capture;

/**
 * Lightweight SQL statement classification for the transaction-control rule of
 * spec/data-stores.md: during a Preview a provider refuses, before it reaches the database, any
 * statement that would end or escape the Preview transaction. The check is deliberately
 * conservative: an unrecognised statement that might end the transaction is refused.
 *
 * On MySQL and MariaDB `CALL` is refused too, because a stored procedure can commit, unless the
 * host declared the procedure safe by exact name; so are SQL-level `PREPARE` and `EXECUTE`, which
 * run statement text the guard never saw.
 *
 * Quotes and comments are read the way each server reads them by default: on MySQL backslashes
 * escape inside every string, `#` starts a comment and `--` does only when a space follows;
 * elsewhere a standard string has no backslash escapes (PostgreSQL's `E'...'` strings do) and
 * `$tag$` quotes a body. A literal that ended later than the server's would hide a statement the
 * server runs.
 */
final class Statements
{
    /** MySQL and MariaDB run the body of `/*! ... *\/` and `/*M! ... *\/` comments as SQL. */
    private const EXECUTABLE_COMMENT = '/^\/\*M?!\d*/';

    private const TRANSACTION_CONTROL = '/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b)|PREPARE\s+TRANSACTION|XA\b|SET\s+(?:(?:SESSION|GLOBAL|LOCAL)\s+|@@(?:SESSION\.|GLOBAL\.)?)?AUTOCOMMIT\b)/i';

    /** A `SET` that changes autocommit anywhere in its list (`SET sql_mode = '', autocommit = 1`). */
    private const SET_AUTOCOMMIT = '/^SET\b.*(?<![\w$])AUTOCOMMIT\b/is';

    /**
     * SQL Server's `SET IMPLICIT_TRANSACTIONS ON` makes the statement after a commit open a new transaction, which
     * hides the commit from a count of open transactions. Any `SET` naming it is refused (it may share a list with
     * other options, `SET NOCOUNT, IMPLICIT_TRANSACTIONS ON`), except exactly `SET IMPLICIT_TRANSACTIONS OFF`, which
     * leaves the open transaction alone and which EF Core sends at the start of its batches.
     */
    private const SET_IMPLICIT_TRANSACTIONS = '/^SET\b.*(?<![\w$])IMPLICIT_TRANSACTIONS\b/is';
    private const IMPLICIT_TRANSACTIONS_OFF = '/^SET\s+IMPLICIT_TRANSACTIONS\s+OFF\s*$/i';

    /** MySQL commits the open transaction before (and after) these statements. https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html */
    private const MYSQL_IMPLICIT_COMMIT = '/^(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES?|UNLOCK\s+TABLES?|ANALYZE|OPTIMIZE|REPAIR|CHECK\s+TABLES?|FLUSH|INSTALL|UNINSTALL|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|SET\s+DEFAULT\s+ROLE|START\s+(?:REPLICA|SLAVE|GROUP_REPLICATION)|STOP\s+(?:REPLICA|SLAVE|GROUP_REPLICATION)|CHANGE\s+(?:REPLICATION|MASTER)|IMPORT\s+TABLE|CLONE)\b/i';
    private const MYSQL_TEMPORARY_TABLE = '/^(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b/i';

    /** SQL-level `PREPARE ... FROM` and `EXECUTE` (also MariaDB's `EXECUTE IMMEDIATE`): they run text the guard never sees. */
    private const MYSQL_EXECUTE = '/^(?:PREPARE|EXECUTE)\b/i';

    /** `CALL name`, `CALL schema.name`, with or without backticks; the name is captured. */
    private const MYSQL_CALL = '/^CALL\s+((?:`(?:[^`]|``)+`|[\w$]+)(?:\s*\.\s*(?:`(?:[^`]|``)+`|[\w$]+))?)/i';
    private const MYSQL_CALL_KEYWORD = '/^CALL\b/i';

    /** A declared safe procedure: a plain name, optionally qualified with its schema. */
    private const PROCEDURE_NAME = '/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/D';

    /**
     * Whether a statement executed inside the Preview transaction can end or replace it.
     * Savepoint statements are allowed, because ORMs use them for nested transactions. `$mysql`
     * adds the statements MySQL and MariaDB commit implicitly, `CALL` and `EXECUTE`.
     *
     * @param list<string> $safeProcedures lower-cased names from {@see normalizeProcedures()}
     * @param string|null $reserved a savepoint the provider owns: the handler may not release or roll back to it
     */
    public static function endsTransaction(string $sql, bool $mysql = false, array $safeProcedures = [], ?string $reserved = null): bool
    {
        return self::reason($sql, $mysql, $safeProcedures, $reserved) !== null;
    }

    /**
     * Why `$sql` would end or escape the Preview transaction, or null when it is safe.
     *
     * @param list<string> $safeProcedures
     */
    public static function reason(string $sql, bool $mysql = false, array $safeProcedures = [], ?string $reserved = null): ?string
    {
        foreach (self::split($sql, $mysql) as $statement) {
            $verb = strtoupper((string) strtok($statement, " \t\r\n("));
            if (preg_match(self::TRANSACTION_CONTROL, $statement) === 1 || preg_match(self::SET_AUTOCOMMIT, $statement) === 1
                || (preg_match(self::SET_IMPLICIT_TRANSACTIONS, $statement) === 1 && preg_match(self::IMPLICIT_TRANSACTIONS_OFF, $statement) !== 1)) {
                return "the handler's {$verb} would end the Preview transaction";
            }
            if ($reserved !== null && preg_match('/^(?:RELEASE|ROLLBACK|SAVEPOINT|SAVE)\b/i', $statement) === 1
                && preg_match('/(?<![\w$])`?' . preg_quote($reserved, '/') . '`?(?![\w$])/i', $statement) === 1) {
                return "the Preview's own savepoint is reserved for Sendproof";
            }
            if (!$mysql) {
                continue;
            }
            if (preg_match(self::MYSQL_CALL_KEYWORD, $statement) === 1) {
                if (preg_match(self::MYSQL_CALL, $statement, $match) === 1 && in_array(self::procedureKey($match[1]), $safeProcedures, true)) {
                    continue;
                }

                return 'a CALL can commit the Preview transaction inside the procedure; declare the procedure safe by exact name if it never commits';
            }
            if (preg_match(self::MYSQL_EXECUTE, $statement) === 1) {
                return "the handler's {$verb} runs a statement the Preview can't check";
            }
            if (preg_match(self::MYSQL_IMPLICIT_COMMIT, $statement) === 1 && preg_match(self::MYSQL_TEMPORARY_TABLE, $statement) !== 1) {
                return "the handler's {$verb} commits implicitly on MySQL";
            }
        }

        return null;
    }

    /**
     * Checks and lower-cases the host's declared safe procedures. MySQL and MariaDB procedure names
     * are case-insensitive, so `Refresh_Totals` and `refresh_totals` are one procedure. Exact names
     * only: wildcards and quoting are rejected rather than guessed at.
     *
     * @param iterable<mixed> $names
     * @return list<string>
     * @throws \InvalidArgumentException for anything but an exact name
     */
    public static function normalizeProcedures(iterable $names): array
    {
        $normalized = [];
        foreach ($names as $name) {
            if (!is_string($name) || preg_match(self::PROCEDURE_NAME, $name) !== 1) {
                throw new \InvalidArgumentException('A safe procedure must be an exact name such as "refresh_totals", not ' . var_export($name, true) . '.');
            }
            $normalized[strtolower($name)] = true;
        }

        return array_keys($normalized);
    }

    /**
     * Why the server itself ended the Preview transaction with error `$code`, or null.
     *
     * On MySQL and MariaDB a deadlock (1213) rolls back the whole transaction, and so does a lock
     * wait timeout (1205) when `innodb_rollback_on_timeout` is on; `$rollbackOnTimeout` reads that
     * setting only when needed and should answer true when it can't. Every later statement would
     * run outside the Preview transaction, and with autocommit on commit for real.
     *
     * On SQL Server (`$sqlServer`) a deadlock victim (1205) does the same. An error under `XACT_ABORT ON`
     * also rolls the transaction back, and the code doesn't show it: the caller runs {@see SQL_SERVER_STATE}.
     *
     * @param \Closure(): bool $rollbackOnTimeout
     */
    public static function serverEndedTransaction(int|string|null $code, bool $mysql, \Closure $rollbackOnTimeout, bool $sqlServer = false): ?string
    {
        if ($sqlServer) {
            return (int) $code === 1205 ? 'a deadlock rolled back the Preview transaction' : null;
        }
        if (!$mysql) {
            return null;
        }
        $code = (int) $code;
        if ($code === 1213) {
            return 'a deadlock rolled back the Preview transaction';
        }
        if ($code === 1205 && $rollbackOnTimeout()) {
            return 'a lock wait timeout rolled back the Preview transaction';
        }

        return null;
    }

    /**
     * The query a provider runs on SQL Server after any server error other than a deadlock victim, to learn whether
     * the error rolled the Preview transaction back (answer to {@see sqlServerTransactionGone()}): the open
     * transaction count and the session's `XACT_ABORT` setting.
     */
    public const SQL_SERVER_STATE = 'SELECT @@TRANCOUNT, CASE WHEN (@@OPTIONS & 16384) = 16384 THEN 1 ELSE 0 END';

    /**
     * Whether SQL Server rolled the whole transaction back after an error: no transaction is open, or the session
     * runs under `XACT_ABORT ON`, where a run-time error ends the transaction. The second test is needed because a
     * driver with auto-commit off (ODBC, so `pdo_sqlsrv`) runs the connection with `IMPLICIT_TRANSACTIONS ON`, and
     * the statement after a rollback then opens a new transaction and the count reads 1 again.
     *
     * @param list<mixed>|null $state the row of {@see SQL_SERVER_STATE}; null (unknown) counts as gone
     */
    public static function sqlServerTransactionGone(?array $state): bool
    {
        return $state === null || (int) ($state[0] ?? 0) === 0 || (int) ($state[1] ?? 0) === 1;
    }

    /** `` `Shop` . `Rebuild` `` becomes `shop.rebuild`; a quoted name that isn't a plain name never matches. */
    private static function procedureKey(string $name): string
    {
        $parts = preg_split('/\s*\.\s*/', $name) ?: [$name];

        return strtolower(implode('.', array_map(static fn (string $part): string => trim($part, '`'), $parts)));
    }

    /**
     * Splits SQL text into statements, ignoring separators inside quotes and comments.
     *
     * The body of a MySQL executable comment is kept as statement text, because the server runs it:
     * `/*!COMMIT*\/` is a COMMIT, not a comment.
     *
     * @param bool $mysql read quotes and comments the way MySQL and MariaDB do
     * @return list<string>
     */
    public static function split(string $sql, bool $mysql = false): array
    {
        $statements = [];
        $current = '';
        $index = 0;
        $executable = false;
        $length = strlen($sql);
        while ($index < $length) {
            $char = $sql[$index];
            $next = $sql[$index + 1] ?? '';
            if ($executable && $char === '*' && $next === '/') {
                $executable = false;
                $index += 2;
                $current .= ' ';
                continue;
            }
            $dashComment = $char === '-' && $next === '-'
                && (!$mysql || !isset($sql[$index + 2]) || ctype_space($sql[$index + 2]) || ctype_cntrl($sql[$index + 2]));
            if ($dashComment || ($mysql && $char === '#')) {
                $end = strpos($sql, "\n", $index);
                $index = $end === false ? $length : $end + 1;
                $current .= ' ';
                continue;
            }
            // Read as SQL on every database: a stricter check elsewhere, where only MySQL runs it.
            if ($char === '/' && $next === '*' && !$executable && preg_match(self::EXECUTABLE_COMMENT, substr($sql, $index, 16), $opener) === 1) {
                $executable = true;
                $index += strlen($opener[0]);
                $current .= ' ';
                continue;
            }
            if ($char === '/' && $next === '*') {
                $end = strpos($sql, '*/', $index + 2);
                $index = $end === false ? $length : $end + 2;
                $current .= ' ';
                continue;
            }
            if ($char === "'" || $char === '"' || $char === '`') {
                $end = self::closingQuote($sql, $index, $char, self::backslashEscapes($sql, $index, $char, $mysql));
                $current .= substr($sql, $index, $end - $index);
                $index = $end;
                continue;
            }
            if ($char === '$' && ($mysql || ($index > 0 && preg_match('/[\w$]/', $sql[$index - 1]) === 1))) {
                $current .= $char;
                $index++;
                continue;
            }
            if ($char === '$' && preg_match('/^\$[A-Za-z_]*\$/', substr($sql, $index), $tag) === 1) {
                $end = strpos($sql, $tag[0], $index + strlen($tag[0]));
                $stop = $end === false ? $length : $end + strlen($tag[0]);
                $current .= substr($sql, $index, $stop - $index);
                $index = $stop;
                continue;
            }
            if ($char === ';') {
                if (trim($current) !== '') {
                    $statements[] = trim($current);
                }
                $current = '';
                $index++;
                continue;
            }
            $current .= $char;
            $index++;
        }
        if (trim($current) !== '') {
            $statements[] = trim($current);
        }

        return $statements;
    }

    /** Whether a backslash escapes the next character inside the quote that opens at `$index`. */
    private static function backslashEscapes(string $sql, int $index, string $quote, bool $mysql): bool
    {
        if ($mysql) {
            return $quote !== '`';
        }

        return $quote === "'" && $index > 0 && ($sql[$index - 1] === 'E' || $sql[$index - 1] === 'e')
            && ($index === 1 || preg_match('/[\w$]/', $sql[$index - 2]) !== 1);
    }

    private static function closingQuote(string $sql, int $start, string $quote, bool $backslash): int
    {
        $length = strlen($sql);
        $index = $start + 1;
        while ($index < $length) {
            if ($backslash && $sql[$index] === '\\') {
                $index += 2;
                continue;
            }
            if ($sql[$index] === $quote) {
                if (($sql[$index + 1] ?? '') === $quote) {
                    $index += 2;
                    continue;
                }

                return $index + 1;
            }
            $index++;
        }

        return $length;
    }
}
