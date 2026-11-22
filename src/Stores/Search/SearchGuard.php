<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Search;

use Closure;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Sendproof\Core\Stores\Classifier;
use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\Guard;

/**
 * The write guard shared by the Elasticsearch and OpenSearch hooks (spec/data-stores.md, `guard`
 * mode). Every hook funnels a request here before it is sent: {@see begin()} classifies it by method
 * and path with the shared `elasticsearch.json` table, lets the {@see Guard} refuse a write in a
 * Preview, and returns the pending `Db` log entry, which {@see finish()} completes after the reply.
 *
 * `$system` is `elasticsearch` or `opensearch`: one table covers both engines, and the store is
 * reported under the name of the client library that sent the request.
 */
final class SearchGuard
{
    /** A request or reply body above this size is not parsed for the log. */
    private const LOG_LIMIT = 1_048_576;

    /** @var list<string> path prefixes a client is configured with, longest first, each `/prefix` */
    private readonly array $prefixes;

    /**
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     * @param list<string> $pathPrefixes paths the client's hosts carry (`https://host/search`), which the table doesn't know
     */
    public function __construct(
        private readonly Guard $guard,
        private readonly string $system,
        private readonly ?array $reads = null,
        array $pathPrefixes = [],
    ) {
        $prefixes = [];
        foreach ($pathPrefixes as $prefix) {
            $prefix = '/' . trim($prefix, '/');
            if ($prefix !== '/') {
                $prefixes[$prefix] = true;
            }
        }
        $names = array_keys($prefixes);
        usort($names, static fn (string $a, string $b): int => strlen($b) <=> strlen($a));
        $this->prefixes = $names;
    }

    /** The store id this guard reports, `elasticsearch` or `opensearch`. */
    public function system(): string
    {
        return $this->system;
    }

    /** The guard that decides, so a hook can resolve the request's recorder. */
    public function guard(): Guard
    {
        return $this->guard;
    }

    /**
     * Classifies a request and refuses it when it is a write during a Preview. Call it before
     * any byte is sent.
     *
     * @param string $uri the request target: the path, with the query string if any
     * @param Closure(): ?string $body reads the request body as text; called only when the table needs
     *        it (a SQL endpoint) or the request is logged
     * @return array<string,mixed>|null the pending log entry, or null for a session call, and when nothing is captured
     * @throws \Sendproof\Core\Stores\PreviewWriteBlockedException
     */
    public function begin(string $method, string $uri, Closure $body): ?array
    {
        $path = $this->withoutPrefix(explode('?', $uri, 2)[0]);
        $text = null;
        $read = static function () use ($body, &$text): ?string {
            return $text ??= $body() ?? '';
        };
        $result = Classifier::elasticsearch($method, $path, static fn (): ?string => $read());
        $kind = $result['kind'];
        $operation = $result['operation'];
        if ($kind === CommandKind::Write && isset($this->reads[$operation])) {
            $kind = CommandKind::Read;
        }
        $this->guard->guard($this->system, $operation, $kind);
        if ($kind === CommandKind::Session || !$this->guard->recorder()->isCapturing()) {
            return null;
        }
        $entry = ['system' => $this->system, 'operation' => $operation, 'target' => Classifier::elasticsearchTarget($path)];
        $statement = $this->statementOf($read());
        if ($statement !== null) {
            $entry['statement'] = $statement;
        }

        return ['entry' => $entry, 'started' => hrtime(true)];
    }

    /**
     * Completes and records the `Db` entry of a request that {@see begin()} returned.
     *
     * @param array<string,mixed>|null $pending
     * @param int|null $status the HTTP status, when there was a reply
     * @param string|null $reply the reply body, when it could be read
     * @param string|null $failure the error name when no reply came
     */
    public function finish(?array $pending, ?int $status, ?string $reply, ?string $failure = null): void
    {
        if ($pending === null) {
            return;
        }
        $entry = $pending['entry'] + ['elapsedMs' => (hrtime(true) - $pending['started']) / 1e6];
        $decoded = $reply !== null && strlen($reply) <= self::LOG_LIMIT ? json_decode($reply, true) : null;
        $decoded = is_array($decoded) ? $decoded : [];
        if ($failure !== null) {
            $entry['error'] = $failure;
        } elseif ($status !== null && $status >= 400) {
            $type = $decoded['error']['type'] ?? null;
            $entry['error'] = is_string($type) && $type !== '' ? $type : (string) $status;
        } else {
            $rows = is_array($decoded['hits']['hits'] ?? null) ? count($decoded['hits']['hits'])
                : (is_int($decoded['updated'] ?? null) ? $decoded['updated'] : (is_int($decoded['deleted'] ?? null) ? $decoded['deleted'] : (isset($decoded['result']) ? 1 : null)));
            if ($rows !== null) {
                $entry['rowsAffected'] = $rows;
            }
        }
        $this->guard->recorder()->db($entry);
    }

    /**
     * Guards a PSR-7 request: classifies it, and returns the pending log entry. The body is read
     * only when needed, and put back so the client still sends all of it.
     *
     * @return array<string,mixed>|null
     */
    public function beginRequest(RequestInterface $request): ?array
    {
        $uri = $request->getUri();
        $target = $uri->getPath() . ($uri->getQuery() !== '' ? '?' . $uri->getQuery() : '');

        return $this->begin($request->getMethod(), $target, static function () use ($request): ?string {
            $stream = $request->getBody();
            if (!$stream->isSeekable()) {
                // Reading would consume it. The statement is left out and a SQL body counts as unreadable (a write).
                return null;
            }
            $size = $stream->getSize();
            if ($size !== null && $size > self::LOG_LIMIT) {
                return null;
            }
            $position = $stream->tell();
            $stream->rewind();
            $text = $stream->getContents();
            $stream->seek($position);

            return $text;
        });
    }

    /**
     * Completes the log entry for a PSR-7 reply, reading its body only while the Preview or the
     * observed Send is capturing, and leaving it readable for the client.
     *
     * @param array<string,mixed>|null $pending
     */
    public function finishResponse(?array $pending, ResponseInterface $response): void
    {
        if ($pending === null) {
            return;
        }
        $stream = $response->getBody();
        $text = null;
        $size = $stream->getSize();
        if ($stream->isSeekable() && ($size === null || $size <= self::LOG_LIMIT)) {
            $position = $stream->tell();
            $stream->rewind();
            $text = $stream->getContents();
            $stream->seek($position);
        }
        $this->finish($pending, $response->getStatusCode(), $text);
    }

    /** Drops a configured path prefix, so `/search/articles/_search` is classified as `/articles/_search`. */
    private function withoutPrefix(string $path): string
    {
        $normal = '/' . trim($path, '/');
        foreach ($this->prefixes as $prefix) {
            if ($normal === $prefix || str_starts_with($normal, $prefix . '/')) {
                return substr($normal, strlen($prefix)) ?: '/';
            }
        }

        return $path;
    }

    /**
     * The request body as a log statement: every literal replaced by `?`, field names and operators
     * kept, one line per NDJSON line. Text that isn't JSON is left out.
     */
    private function statementOf(?string $text): ?string
    {
        if ($text === null || trim($text) === '' || strlen($text) > self::LOG_LIMIT) {
            return null;
        }
        $whole = json_decode($text);
        if ($whole !== null || trim($text) === 'null') {
            return json_encode(Guard::sanitizeDocument($whole), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: null;
        }
        $lines = [];
        foreach (preg_split('/\R/', trim($text)) ?: [] as $line) {
            $decoded = json_decode($line);
            if ($decoded === null && trim($line) !== 'null') {
                return null;
            }
            $lines[] = json_encode(Guard::sanitizeDocument($decoded), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }

        return $lines === [] ? null : implode("\n", $lines);
    }
}
