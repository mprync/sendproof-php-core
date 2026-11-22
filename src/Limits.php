<?php

declare(strict_types=1);

namespace Sendproof\Core;

/**
 * Capture limits shared by every adapter. They mirror the .NET adapters so one UI renders any host.
 */
final class Limits
{
    public const LOGS = 500;
    public const EFFECTS = 100;
    public const CHANGES = 200;
    public const PROPERTIES = 32;
    public const PARAMETERS = 64;
    public const NAME = 256;
    public const TEXT = 4096;
    public const PAYLOAD_BYTES = 16 * 1024;
    public const LOG_BUDGET = 128 * 1024;
    public const PAYLOAD_BUDGET = 128 * 1024;
    /** Largest inner response a preview will carry back (1 MiB). */
    public const RESPONSE_BYTES = 1024 * 1024;
    public const REDACTED = '[REDACTED]';
    private const MAX_DEPTH = 16;
    /** Matches how envelopes are written, so sizes reflect what is sent. */
    private const JSON_FLAGS = JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

    /** Clips text to a number of characters without splitting a multibyte character. */
    public static function clip(string $value, int $maximum = self::TEXT): string
    {
        return mb_strlen($value, 'UTF-8') <= $maximum ? $value : mb_substr($value, 0, $maximum, 'UTF-8');
    }

    /**
     * Normalises a host value into bounded, JSON-safe data. Sets $truncated whenever
     * something was clipped, dropped or replaced, and returns null for unusable values.
     */
    public static function payload(mixed $value, bool &$truncated): mixed
    {
        $normalized = self::normalize($value, 0, $truncated);
        if ($normalized !== null) {
            $json = json_encode($normalized, self::JSON_FLAGS);
            if ($json === false || strlen($json) > self::PAYLOAD_BYTES) {
                $truncated = true;
                return null;
            }
        }

        return $normalized;
    }

    /** Estimated serialized size of a captured value, used for budgets. */
    public static function size(mixed $value): int
    {
        return $value === null ? 0 : strlen((string) json_encode($value, self::JSON_FLAGS));
    }

    /**
     * Applies the change cap and payload budget to provider-supplied changes.
     *
     * @param list<array{operation:string,table:string,key:mixed,before:mixed,after:mixed,store?:string,namespace?:string,via?:string}> $changes
     * @return array{0:list<array<string,mixed>>,1:bool}
     */
    public static function snapshotChanges(array $changes): array
    {
        $result = [];
        $truncated = count($changes) > self::CHANGES;
        $remaining = self::PAYLOAD_BUDGET;
        foreach (array_slice($changes, 0, self::CHANGES) as $change) {
            $key = self::payload($change['key'] ?? null, $truncated);
            $before = self::payload($change['before'] ?? null, $truncated);
            $after = self::payload($change['after'] ?? null, $truncated);
            $operation = self::clip((string) $change['operation'], self::NAME);
            $table = self::clip((string) $change['table'], self::NAME);
            $remaining -= self::size($key) + self::size($before) + self::size($after) + strlen($operation) + strlen($table);
            if ($remaining < 0) {
                $truncated = true;
                break;
            }

            $truncated = $truncated || $operation !== $change['operation'] || $table !== $change['table'];
            $entry = ['operation' => $operation, 'table' => $table, 'key' => $key, 'before' => $before, 'after' => $after];
            // Document, item and key changes name their store, database and how the change was made.
            foreach (['store', 'namespace', 'via'] as $field) {
                if (isset($change[$field]) && is_string($change[$field])) {
                    $entry[$field] = self::clip($change[$field], self::NAME);
                }
            }
            $result[] = $entry;
        }

        return [$result, $truncated];
    }

    private static function normalize(mixed $value, int $depth, bool &$truncated): mixed
    {
        if ($depth >= self::MAX_DEPTH) {
            $truncated = true;
            return null;
        }

        switch (true) {
            case $value === null || is_bool($value) || is_int($value):
                return $value;
            case is_float($value):
                if (is_nan($value) || is_infinite($value)) {
                    $truncated = true;
                    return null;
                }
                return $value;
            case is_string($value):
                return self::text($value, $truncated);
            case $value instanceof \DateTimeInterface:
                return $value->format('Y-m-d\TH:i:s.vP');
            case $value instanceof \BackedEnum:
                return $value->value;
            case $value instanceof \UnitEnum:
                return $value->name;
            case $value instanceof \JsonSerializable:
                return self::normalize($value->jsonSerialize(), $depth + 1, $truncated);
            case $value instanceof \Stringable:
                return self::text((string) $value, $truncated);
            case is_array($value) || is_object($value):
                $items = is_array($value) ? $value : get_object_vars($value);
                $isList = array_is_list($items);
                $out = [];
                foreach ($items as $key => $item) {
                    if (count($out) === self::PARAMETERS) {
                        $truncated = true;
                        break;
                    }
                    $normalized = self::normalize($item, $depth + 1, $truncated);
                    if ($isList) {
                        $out[] = $normalized;
                    } else {
                        $name = self::clip((string) $key, self::NAME);
                        $truncated = $truncated || $name !== (string) $key;
                        $out[$name] = $normalized;
                    }
                }
                return $out;
            default:
                $truncated = true;
                return null;
        }
    }

    private static function text(string $value, bool &$truncated): string
    {
        if (!mb_check_encoding($value, 'UTF-8')) {
            $length = intdiv(self::TEXT * 3, 4);
            $truncated = $truncated || strlen($value) > $length;
            return base64_encode(substr($value, 0, $length));
        }

        $clipped = self::clip($value);
        $truncated = $truncated || $clipped !== $value;
        return $clipped;
    }
}
