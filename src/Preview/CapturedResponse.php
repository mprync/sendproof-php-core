<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

/** A buffered inner response produced by dispatching a preview request in-process. */
final class CapturedResponse
{
    /**
     * @param array<string,string> $headers Header values keyed by name
     * @param \Throwable|null $failure An unhandled error that the framework turned into a response
     */
    public function __construct(
        public readonly int $status,
        public readonly array $headers,
        public readonly string $body,
        public readonly ?\Throwable $failure = null,
    ) {
    }

    public function header(string $name): ?string
    {
        foreach ($this->headers as $key => $value) {
            if (strcasecmp($key, $name) === 0) {
                return $value;
            }
        }

        return null;
    }
}
