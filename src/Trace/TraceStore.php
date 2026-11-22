<?php

declare(strict_types=1);

namespace Sendproof\Core\Trace;

/** Holds observed-send traces for a short time so the workbench can read them after the response. */
interface TraceStore
{
    /**
     * Stores a trace for an owner and returns its identifier.
     *
     * @param array<string,mixed> $trace
     */
    public function put(string $ownerKey, array $trace): string;

    /**
     * Returns a trace only to the owner that created it.
     *
     * @return array<string,mixed>|null Null when missing, expired, evicted or owned by someone else
     */
    public function get(string $id, string $ownerKey): ?array;
}
