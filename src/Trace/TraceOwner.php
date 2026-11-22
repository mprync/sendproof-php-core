<?php

declare(strict_types=1);

namespace Sendproof\Core\Trace;

/** Identifies who may read a trace: a stable authenticated subject within one authentication context. */
final class TraceOwner
{
    /**
     * Builds an owner key, or null when no stable subject exists or a field is oversized.
     *
     * @param string $context Guard or authentication scheme name
     */
    public static function key(string $context, ?string $subject, string $pathBase): ?string
    {
        if ($subject === null || $subject === '' || strlen($subject) > 256 || strlen($context) > 256 || strlen($pathBase) > 4096) {
            return null;
        }

        return hash('sha256', json_encode([$context, $subject, $pathBase], JSON_THROW_ON_ERROR));
    }
}
