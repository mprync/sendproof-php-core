<?php

declare(strict_types=1);

namespace Sendproof\Core\Capture;

use Sendproof\Core\Limits;

/**
 * Builds the protocol's SQL log entry and hides parameter values that may be secret.
 *
 * Names are matched as whole words, so `idempotency_key` stays visible while `password_hash`,
 * `api_key` and `refresh_token` are hidden. A statement that mentions a secret-looking name
 * hides every value, because bindings cannot reliably be mapped back to columns.
 */
final class SqlRedactor
{
    private const SECRET_WORDS = ['password', 'passwd', 'pwd', 'secret', 'token', 'hash', 'salt', 'credential', 'credentials', 'apikey'];
    private const KEY_QUALIFIERS = ['api', 'private', 'secret', 'access', 'signing', 'encryption', 'client'];

    /**
     * @param list<array{name:string,value:mixed}> $bindings
     * @return array{0:array{text:string,parameters:list<array{name:string,value:?string,dbType:string}>,rowsAffected?:int},1:bool}
     */
    public static function entry(string $text, array $bindings, bool $showValues, ?int $rowsAffected = null): array
    {
        $clipped = Limits::clip($text);
        $truncated = $clipped !== $text || count($bindings) > Limits::PARAMETERS;
        $hideAll = !$showValues || self::looksSecret($text);
        $parameters = [];
        foreach (array_slice($bindings, 0, Limits::PARAMETERS) as $binding) {
            $name = Limits::clip((string) $binding['name'], Limits::NAME);
            $truncated = $truncated || $name !== (string) $binding['name'];
            $value = $hideAll || self::looksSecret((string) $binding['name']) ? Limits::REDACTED : self::value($binding['value'], $truncated);
            $parameters[] = ['name' => $name, 'value' => $value, 'dbType' => self::type($binding['value'])];
        }

        $entry = ['text' => $clipped, 'parameters' => $parameters];
        if ($rowsAffected !== null) {
            $entry['rowsAffected'] = $rowsAffected;
        }

        return [$entry, $truncated];
    }

    /** Whether an identifier or statement names a secret, judged by whole words. */
    public static function looksSecret(string $text): bool
    {
        $previous = null;
        foreach (preg_split('/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u', $text, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $word) {
            $lower = strtolower($word);
            if (in_array($lower, self::SECRET_WORDS, true) || ($lower === 'key' && $previous !== null && in_array($previous, self::KEY_QUALIFIERS, true))) {
                return true;
            }
            $previous = $lower;
        }

        return false;
    }

    /**
     * Replaces the value of every secret-named field with `[REDACTED]`, at any depth of a nested
     * document. Lists keep their shape; a document's field names decide, never its values.
     */
    public static function redactDeep(mixed $value): mixed
    {
        if (is_array($value)) {
            $out = [];
            foreach ($value as $name => $inner) {
                $out[$name] = is_string($name) && self::looksSecret($name) ? Limits::REDACTED : self::redactDeep($inner);
            }

            return $out;
        }
        if ($value instanceof \stdClass) {
            return (object) self::redactDeep((array) $value);
        }

        return $value;
    }

    private static function value(mixed $value, bool &$truncated): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_bool($value)) {
            return $value ? '1' : '0';
        }
        if (is_resource($value)) {
            $truncated = true;
            return null;
        }
        $string = is_scalar($value) || $value instanceof \Stringable ? (string) $value : (json_encode($value) ?: '');
        if (!mb_check_encoding($string, 'UTF-8')) {
            $length = intdiv(Limits::TEXT, 2);
            $truncated = $truncated || strlen($string) > $length;
            return strtoupper(bin2hex(substr($string, 0, $length)));
        }
        $clipped = Limits::clip($string);
        $truncated = $truncated || $clipped !== $string;

        return $clipped;
    }

    private static function type(mixed $value): string
    {
        return match (true) {
            $value === null => 'Null',
            is_bool($value) => 'Boolean',
            is_int($value) => 'Int64',
            is_float($value) => 'Double',
            default => 'String',
        };
    }
}
