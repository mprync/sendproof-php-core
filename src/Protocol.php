<?php

declare(strict_types=1);

namespace Sendproof\Core;

/** Parsing and validation rules of Sendproof protocol v1 that do not depend on a web framework. */
final class Protocol
{
    public const PREFIX = '/sendproof/_preview';
    public const ROLLBACK_PREFERENCE = 'tx=rollback';
    public const TRACE_HEADER = 'X-Sendproof-Trace';

    /** True when any Prefer value asks for `tx=rollback`, possibly among other preferences. */
    public static function requestsRollback(array $preferValues): bool
    {
        foreach ($preferValues as $value) {
            foreach (preg_split('/[,;]/', (string) $value) ?: [] as $part) {
                $pair = array_map('trim', explode('=', $part, 2));
                if (count($pair) === 2 && strcasecmp($pair[0], 'tx') === 0 && strcasecmp(trim($pair[1], '"'), 'rollback') === 0) {
                    return true;
                }
            }
        }

        return false;
    }

    /** A preview needs exactly one Prefer header whose whole value is `tx=rollback`. */
    public static function hasExactPreference(array $preferValues): bool
    {
        return count($preferValues) === 1 && strcasecmp(trim((string) $preferValues[0]), self::ROLLBACK_PREFERENCE) === 0;
    }

    /** True when any Prefer token is `trace`, used for Observed Send. */
    public static function requestsTrace(array $preferValues): bool
    {
        foreach ($preferValues as $value) {
            foreach (explode(',', (string) $value) as $token) {
                if (strcasecmp(trim(explode(';', $token, 2)[0]), 'trace') === 0) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Rejects cross-site browser requests. An absent Origin is allowed because non-browser clients omit it.
     *
     * @param list<string> $origins Origin header values
     * @param string $schemeAndHost Expected origin such as `http://127.0.0.1:8080`
     */
    public static function isSameOrigin(?string $secFetchSite, array $origins, string $schemeAndHost): bool
    {
        if ($secFetchSite !== null && strcasecmp($secFetchSite, 'cross-site') === 0) {
            return false;
        }
        if (count($origins) === 0) {
            return true;
        }
        if (count($origins) !== 1) {
            return false;
        }

        $origin = parse_url($origins[0]);
        $expected = parse_url($schemeAndHost);
        if ($origin === false || $expected === false || !isset($origin['scheme'], $origin['host'], $expected['scheme'], $expected['host'])) {
            return false;
        }

        return strcasecmp($origin['scheme'], $expected['scheme']) === 0
            && strcasecmp($origin['host'], $expected['host']) === 0
            && ($origin['port'] ?? self::defaultPort($origin['scheme'])) === ($expected['port'] ?? self::defaultPort($expected['scheme']))
            && !isset($origin['user'], $origin['pass'], $origin['query'], $origin['fragment'])
            && ($origin['path'] ?? '') === '';
    }

    /**
     * Finds the reserved preview prefix in a request path.
     *
     * @return int|null Offset of the prefix, or null when the path is not a preview URL
     */
    public static function reservedOffset(string $path): ?int
    {
        $offset = stripos($path, self::PREFIX);
        if ($offset === false) {
            return null;
        }
        $end = $offset + strlen(self::PREFIX);

        return $end === strlen($path) || $path[$end] === '/' ? $offset : null;
    }

    /** Whether a preview target path is well formed and stays out of the workbench routes. */
    public static function isValidTarget(string $target): bool
    {
        if ($target === '' || $target[0] !== '/' || str_starts_with($target, '//')) {
            return false;
        }
        $decoded = rawurldecode($target);
        if (str_starts_with($decoded, '//') || str_contains($decoded, '\\') || preg_match('/[\x00-\x1f\x7f]/', $decoded)) {
            return false;
        }
        foreach (explode('/', $decoded) as $segment) {
            if ($segment === '.' || $segment === '..') {
                return false;
            }
        }
        $first = strtolower(explode('/', ltrim($decoded, '/'), 2)[0]);

        return $first !== 'sendproof';
    }

    private static function defaultPort(string $scheme): int
    {
        return strcasecmp($scheme, 'https') === 0 ? 443 : 80;
    }
}
