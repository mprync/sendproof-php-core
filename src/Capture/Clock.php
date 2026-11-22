<?php

declare(strict_types=1);

namespace Sendproof\Core\Capture;

/** Measures the `auth`, `handler`, `db` and `serialize` timing metrics reported through Server-Timing. */
final class Clock
{
    private ?int $handlerStart = null;
    private ?int $handlerEnd = null;

    public function __construct(private readonly int $start)
    {
    }

    public function start(): int
    {
        return $this->start;
    }

    public function startHandler(): void
    {
        $this->handlerStart ??= hrtime(true);
    }

    public function endHandler(): void
    {
        $this->handlerEnd ??= hrtime(true);
    }

    /**
     * @return array{auth:float,handler:float,db:float,queryCount:int,serialize:float}
     */
    public function timing(float $dbMs, int $queries, float $serializeMs): array
    {
        $now = hrtime(true);
        $entered = $this->handlerStart ?? $now;
        $left = $this->handlerEnd ?? $now;

        return [
            'auth' => round(max(0, $entered - $this->start) / 1e6, 3),
            'handler' => round(max(0, $left - $entered) / 1e6, 3),
            'db' => round($dbMs, 3),
            'queryCount' => $queries,
            'serialize' => round($serializeMs, 3),
        ];
    }

    /** Formats a timing array as a Server-Timing header value. */
    public static function header(array $timing): string
    {
        return sprintf(
            'auth;dur=%s, handler;dur=%s, db;dur=%s;desc="%d queries", serialize;dur=%s',
            $timing['auth'],
            $timing['handler'],
            $timing['db'],
            $timing['queryCount'],
            $timing['serialize'],
        );
    }
}
