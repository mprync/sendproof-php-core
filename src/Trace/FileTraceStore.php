<?php

declare(strict_types=1);

namespace Sendproof\Core\Trace;

/**
 * File-backed trace store that works across PHP-FPM workers and `php -S` workers.
 *
 * Each trace is a JSON file inside a private directory, written atomically. Entries expire after
 * `$ttlSeconds`; an owner keeps at most `$perOwner` traces and the directory at most `$total`.
 * Older entries are evicted first. Tests can shorten the TTL or inject a clock.
 *
 * The directory must be private to the server's user. It is created with mode 0700; an existing
 * directory that is a symbolic link, belongs to another user, or is reachable by group or other
 * users is refused (or tightened when this user owns it), so a shared temporary directory cannot
 * be used to read or plant traces. Trace files are created exclusively and made 0600 before any
 * content is written.
 */
final class FileTraceStore implements TraceStore
{
    /** @var \Closure(): float */
    private readonly \Closure $clock;

    public function __construct(
        private readonly string $directory,
        private readonly int $ttlSeconds = 300,
        private readonly int $perOwner = 8,
        private readonly int $total = 32,
        ?\Closure $clock = null,
    ) {
        $this->clock = $clock ?? static fn (): float => microtime(true);
    }

    public function put(string $ownerKey, array $trace): string
    {
        return $this->locked(function () use ($ownerKey, $trace): string {
            $entries = $this->entries();
            $mine = array_values(array_filter($entries, static fn (array $entry): bool => $entry['owner'] === $ownerKey));
            while (count($mine) >= $this->perOwner) {
                $oldest = array_shift($mine);
                @unlink($oldest['file']);
                $entries = array_values(array_filter($entries, static fn (array $entry): bool => $entry['file'] !== $oldest['file']));
            }
            while (count($entries) >= $this->total) {
                $oldest = array_shift($entries);
                @unlink($oldest['file']);
            }

            $id = bin2hex(random_bytes(16));
            $file = $this->directory . DIRECTORY_SEPARATOR . $id . '.json';
            $temporary = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
            $json = json_encode(['owner' => $ownerKey, 'created' => ($this->clock)(), 'trace' => $trace], JSON_THROW_ON_ERROR | JSON_PARTIAL_OUTPUT_ON_ERROR);
            $this->writePrivate($temporary, $json);
            if (!rename($temporary, $file)) {
                @unlink($temporary);
                throw new \RuntimeException('Cannot store the trace.');
            }

            return $id;
        });
    }

    public function get(string $id, string $ownerKey): ?array
    {
        $normalized = strtolower(str_replace('-', '', $id));
        if (!preg_match('/^[0-9a-f]{32}$/', $normalized)) {
            return null;
        }

        return $this->locked(function () use ($normalized, $ownerKey): ?array {
            $file = $this->directory . DIRECTORY_SEPARATOR . $normalized . '.json';
            $entry = $this->read($file);
            if ($entry === null) {
                return null;
            }
            if (($this->clock)() - $entry['created'] >= $this->ttlSeconds) {
                @unlink($file);
                return null;
            }

            return hash_equals($entry['owner'], $ownerKey) ? $entry['trace'] : null;
        });
    }

    /**
     * Live entries oldest first. Expired files are deleted on the way.
     *
     * @return list<array{file:string,owner:string,created:float}>
     */
    private function entries(): array
    {
        $entries = [];
        foreach (glob($this->directory . DIRECTORY_SEPARATOR . '*.json') ?: [] as $file) {
            $entry = $this->read($file);
            if ($entry === null || ($this->clock)() - $entry['created'] >= $this->ttlSeconds) {
                @unlink($file);
                continue;
            }
            $entries[] = ['file' => $file, 'owner' => $entry['owner'], 'created' => $entry['created']];
        }
        // Temporary files left by a worker that died between write and rename.
        foreach (glob($this->directory . DIRECTORY_SEPARATOR . '*.tmp') ?: [] as $file) {
            $modified = @filemtime($file);
            if ($modified !== false && time() - $modified >= $this->ttlSeconds) {
                @unlink($file);
            }
        }
        usort($entries, static fn (array $a, array $b): int => $a['created'] <=> $b['created']);

        return $entries;
    }

    /** @return array{owner:string,created:float,trace:array<string,mixed>}|null */
    private function read(string $file): ?array
    {
        $json = @file_get_contents($file);
        $entry = $json === false ? null : json_decode($json, true);

        return is_array($entry) && isset($entry['owner'], $entry['created'], $entry['trace']) ? $entry : null;
    }

    /** Creates `$file` exclusively, restricts it to this user, then writes `$contents`. */
    private function writePrivate(string $file, string $contents): void
    {
        $handle = @fopen($file, 'x');
        if ($handle === false) {
            throw new \RuntimeException('Cannot create the trace file.');
        }
        try {
            if (!chmod($file, 0600) || fwrite($handle, $contents) !== strlen($contents)) {
                throw new \RuntimeException('Cannot write the trace file.');
            }
        } catch (\Throwable $error) {
            fclose($handle);
            @unlink($file);
            throw $error;
        }
        fclose($handle);
    }

    /** Creates the trace directory, or verifies that an existing one is private to this user. */
    private function ensurePrivateDirectory(): void
    {
        if (is_link($this->directory)) {
            throw new \RuntimeException('The trace directory must not be a symbolic link.');
        }
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new \RuntimeException('Cannot create the trace directory.');
        }
        if (DIRECTORY_SEPARATOR === '\\') {
            return; // POSIX modes and owners do not apply; rely on the directory ACL.
        }
        clearstatcache(true, $this->directory);
        $owner = @fileowner($this->directory);
        if (function_exists('posix_geteuid') && $owner !== posix_geteuid()) {
            throw new \RuntimeException('The trace directory belongs to another user.');
        }
        if ((self::mode($this->directory) & 0077) === 0) {
            return;
        }
        // Owned by this user but too open: tighten it, and refuse if that does not stick.
        if (!@chmod($this->directory, 0700) || (self::mode($this->directory) & 0077) !== 0) {
            throw new \RuntimeException('The trace directory must not be accessible to other users.');
        }
    }

    /** Permission bits of `$path`; all bits set when they cannot be read, so the caller fails closed. */
    private static function mode(string $path): int
    {
        clearstatcache(true, $path);
        $mode = @fileperms($path);

        return $mode === false ? 0777 : $mode & 0777;
    }

    /** @template T @param callable(): T $callback @return T */
    private function locked(callable $callback): mixed
    {
        $this->ensurePrivateDirectory();
        $handle = fopen($this->directory . DIRECTORY_SEPARATOR . '.lock', 'c');
        if ($handle === false || !flock($handle, LOCK_EX)) {
            throw new \RuntimeException('Cannot lock the trace directory.');
        }
        try {
            return $callback();
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }
}
