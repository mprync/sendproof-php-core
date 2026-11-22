<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

/**
 * Lets Previews on one MySQL or MariaDB database run one at a time.
 *
 * InnoDB checks a new key for duplicates under a shared lock. When three or more transactions
 * insert the same key and the first one rolls back, as every Preview does, InnoDB aborts all but
 * one of the rest with a deadlock (error 1213), at any isolation level. Sent for real, the first
 * insert would commit and the others would get a duplicate-key error instead.
 *
 * A PHP application serves requests in separate worker processes (FPM, `php -S` workers, Octane
 * workers), so a lock held in memory could not make them wait. The turn is an advisory file lock,
 * which orders the Previews of every process on the host, a superset of the per-process turn the
 * other bindings take. Previews sent to different hosts of one application still run at the same
 * time, so they can still hit the deadlock; the Preview then fails safely and nothing is written.
 * Sends and observed Sends never wait for a turn.
 */
final class PreviewTurns
{
    /** @var array<string,array{0:resource,1:int}> The turns this process holds, by lock file, and how many holds each has */
    private static array $held = [];

    /**
     * Waits for this database's turn.
     *
     * @param string $database Identifies the database, such as `host:port/name`; never shown or logged
     * @param float $timeoutSeconds How long to wait before giving up
     * @param string|null $directory Where the lock files live; the system temporary directory by default
     * @throws \RuntimeException when the turn did not come in time, or the lock cannot be opened
     */
    public static function take(string $database, float $timeoutSeconds = 60.0, ?string $directory = null): PreviewTurn
    {
        $path = rtrim($directory ?? sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'sendproof-turn-' . hash('sha256', $database) . '.lock';
        // One Preview that enrolls two connections to the same database already has the turn. A
        // second lock on the file from this process would wait for the first, which never comes.
        if (isset(self::$held[$path])) {
            self::$held[$path][1]++;

            return new PreviewTurn($path);
        }
        $handle = fopen($path, 'c');
        if ($handle === false) {
            throw new \RuntimeException('Cannot open the Preview turn lock.');
        }
        $deadline = hrtime(true) + (int) ($timeoutSeconds * 1e9);
        while (!flock($handle, LOCK_EX | LOCK_NB)) {
            if (hrtime(true) >= $deadline) {
                fclose($handle);
                throw new \RuntimeException('Another Preview kept the database for too long, so this Preview did not run.');
            }
            usleep(2000);
        }

        self::$held[$path] = [$handle, 1];

        return new PreviewTurn($path);
    }

    /**
     * Gives back one hold on the turn at `$path`; the lock is released with the last one.
     *
     * @internal Called by {@see PreviewTurn::release()}
     */
    public static function giveBack(string $path): void
    {
        if (!isset(self::$held[$path]) || --self::$held[$path][1] > 0) {
            return;
        }
        $handle = self::$held[$path][0];
        unset(self::$held[$path]);
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}
