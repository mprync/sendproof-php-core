<?php

declare(strict_types=1);

namespace Sendproof\Core\Journeys;

// Match is a reserved word in PHP.
final class MatchValue
{
    public static function any(string $type = 'any'): array
    {
        return ['type' => $type];
    }

    public static function pattern(string $pattern): array
    {
        return ['pattern' => $pattern];
    }

    public static function changed(mixed $from, mixed $to): array
    {
        return ['from' => $from, 'to' => $to];
    }
}
