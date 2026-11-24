<?php

declare(strict_types=1);

namespace Sendproof\Core\Journeys;

final class Ref
{
    public static function input(string $name): string
    {
        return '$inputs.' . $name;
    }

    public static function output(string $step, string $name): string
    {
        return '$steps.' . $step . '.outputs.' . $name;
    }
}
