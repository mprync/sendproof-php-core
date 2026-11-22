<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Search;

use GuzzleHttp\Ring\Core;
use GuzzleHttp\Ring\Future\FutureArrayInterface;

/**
 * A RingPHP handler (the legacy transport of `opensearch-project/opensearch-php` 2) that asks the
 * {@see SearchGuard} about each request before the handler it wraps sends it.
 *
 * It takes the request array first and passes every other argument on, so it fits a `ClientBuilder`
 * handler (`$handler($request)`) and a connection's own (`$handler($request, $connection, $transport, $options)`).
 * A refused write throws before the wrapped handler is called, so no request is built or sent.
 */
final class GuardedRingHandler
{
    /** @param callable $inner the handler to wrap */
    public function __construct(private readonly mixed $inner, private readonly SearchGuard $search)
    {
    }

    /**
     * @param array<string,mixed> $request
     * @return mixed a RingPHP future or response array, as the wrapped handler returns
     */
    public function __invoke(array $request, mixed ...$rest): mixed
    {
        $body = $request['body'] ?? null;
        $pending = $this->search->begin(
            (string) ($request['http_method'] ?? 'GET'),
            (string) ($request['uri'] ?? '/'),
            static fn (): ?string => is_string($body) ? $body : (is_resource($body) ? self::readStream($body) : null),
        );
        $result = ($this->inner)($request, ...$rest);
        if ($pending === null) {
            return $result;
        }
        $finish = function (mixed $response) use ($pending): mixed {
            // A raw handler answers with a RingPHP response (status, body); a connection's own wrapper
            // answers with the decoded body, which is JSON again for the log.
            $isRing = is_array($response) && isset($response['status']) && array_key_exists('body', $response);
            $body = $isRing ? $response['body'] : $response;
            $text = match (true) {
                is_resource($body) => self::readStream($body),
                is_string($body) => $body,
                is_array($body) => json_encode($body) ?: null,
                default => null,
            };
            $this->search->finish($pending, $isRing ? (int) $response['status'] : null, $text);

            return $response;
        };
        if ($result instanceof FutureArrayInterface) {
            // `Core::proxy()` keeps the future's `wait()` and `promise()`, which the transport calls.
            return Core::proxy($result, $finish, function (mixed $error) use ($pending): never {
                $this->search->finish($pending, null, null, is_object($error) ? (new \ReflectionClass($error))->getShortName() : 'error');

                throw $error instanceof \Throwable ? $error : new \RuntimeException('The OpenSearch request failed.');
            });
        }

        return $finish($result);
    }

    /** Reads a seekable stream without moving its position, up to the log limit; null when it can't be read. */
    private static function readStream(mixed $stream): ?string
    {
        if (!(stream_get_meta_data($stream)['seekable'] ?? false)) {
            return null;
        }
        $position = ftell($stream);
        rewind($stream);
        $text = stream_get_contents($stream, 1_048_577);
        fseek($stream, $position === false ? 0 : $position);

        return $text === false || strlen($text) > 1_048_576 ? null : $text;
    }
}
