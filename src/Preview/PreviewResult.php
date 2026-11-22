<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

/** Either a confirmed preview envelope or a rejection the transport must send as a problem response. */
final class PreviewResult
{
    /**
     * @param array<string,mixed>|null $envelope
     * @param array<string,string> $headers
     */
    private function __construct(
        public readonly ?array $envelope,
        public readonly int $status,
        public readonly string $title,
        public readonly array $headers,
        public readonly ?string $timing,
        /** @var array{store:string,operation:string,detail:string}|null */
        public readonly ?array $blocked = null,
    ) {
    }

    /** @param array<string,mixed> $envelope */
    public static function confirmed(array $envelope, string $timing): self
    {
        return new self($envelope, 200, '', [], $timing);
    }

    /** @param array<string,string> $headers */
    public static function rejected(int $status, string $title, array $headers = []): self
    {
        return new self(null, $status, $title, $headers, null);
    }

    /**
     * A Preview the write guard stopped: HTTP 409 with an RFC 9457 problem body, never a confirmation.
     *
     * @param array{store:string,operation:string,detail:string} $write
     */
    public static function blocked(array $write): self
    {
        return new self(null, 409, 'Preview unavailable', [], null, $write);
    }

    /**
     * The `application/problem+json` body of a rejection, or of a blocked Preview with its store,
     * command and `rolledBack: false` (spec/preview-unavailable.schema.json).
     *
     * @return array<string,mixed>
     */
    public function problem(): array
    {
        if ($this->blocked === null) {
            return ['title' => $this->title, 'status' => $this->status];
        }

        return [
            'type' => 'about:blank',
            'title' => 'Preview unavailable',
            'status' => 409,
            'code' => 'preview_unavailable',
            'detail' => $this->blocked['detail'],
            'store' => $this->blocked['store'],
            'operation' => $this->blocked['operation'],
            'rolledBack' => false,
        ];
    }

    public function isConfirmed(): bool
    {
        return $this->envelope !== null;
    }
}
