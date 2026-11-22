<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Firestore;

use Google\ApiCore\Call;
use Google\ApiCore\Transport\TransportInterface;
use Sendproof\Core\Stores\Classifier;
use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\Guard;

/**
 * A gax transport that asks the guard about every Firestore call before the transport it decorates
 * sends it (spec/data-stores.md, `guard` mode).
 *
 * Every call of the Firestore client reaches the network through one of four methods of
 * `Google\ApiCore\Transport\TransportInterface`, whichever wire it uses, gRPC or REST, so the guard
 * sees unary calls and streams alike: `Write` is a bidirectional stream and is refused before it
 * opens, so no message of it is ever sent, and `RunQuery`, `BatchGetDocuments` and `Listen` stream
 * and are reads. A call the table doesn't know is a write.
 */
final class GuardedFirestoreTransport implements TransportInterface
{
    /** A request message above this size is not turned into a log statement. */
    private const LOG_LIMIT = 1_048_576;

    /** @param array<string,true>|null $reads host-declared read method names, matched exactly */
    public function __construct(
        private readonly TransportInterface $inner,
        private readonly Guard $guard,
        private readonly ?array $reads = null,
    ) {
    }

    /** The transport this one decorates. */
    public function inner(): TransportInterface
    {
        return $this->inner;
    }

    public function startUnaryCall(Call $call, array $options)
    {
        $pending = $this->begin($call);
        try {
            $promise = $this->inner->startUnaryCall($call, $options);
        } catch (\Throwable $error) {
            $this->finish($pending, (new \ReflectionClass($error))->getShortName());

            throw $error;
        }
        if ($pending === null) {
            return $promise;
        }

        return $promise->then(
            function (mixed $response) use ($pending): mixed {
                $this->finish($pending);

                return $response;
            },
            function (mixed $error) use ($pending): never {
                $this->finish($pending, is_object($error) ? (new \ReflectionClass($error))->getShortName() : 'error');

                throw $error instanceof \Throwable ? $error : new \RuntimeException('The Firestore call failed.');
            },
        );
    }

    public function startServerStreamingCall(Call $call, array $options)
    {
        return $this->stream($call, fn () => $this->inner->startServerStreamingCall($call, $options));
    }

    public function startClientStreamingCall(Call $call, array $options)
    {
        return $this->stream($call, fn () => $this->inner->startClientStreamingCall($call, $options));
    }

    public function startBidiStreamingCall(Call $call, array $options)
    {
        return $this->stream($call, fn () => $this->inner->startBidiStreamingCall($call, $options));
    }

    public function close()
    {
        $this->inner->close();
    }

    /**
     * Opens a stream through `$open` once the guard has allowed it. A stream's replies arrive after it
     * returns, so its entry is recorded when it opens, without rows.
     */
    private function stream(Call $call, \Closure $open): mixed
    {
        $pending = $this->begin($call);
        try {
            $stream = $open();
        } catch (\Throwable $error) {
            $this->finish($pending, (new \ReflectionClass($error))->getShortName());

            throw $error;
        }
        $this->finish($pending);

        return $stream;
    }

    /**
     * Classifies a call and refuses it when it is a write during a Preview.
     *
     * @return array<string,mixed>|null the pending `Db` entry, or null for a session call or when nothing is captured
     * @throws \Sendproof\Core\Stores\PreviewWriteBlockedException
     */
    private function begin(Call $call): ?array
    {
        $message = $call->getMessage();
        $result = Classifier::firestore($call->getMethod(), is_object($message) || is_array($message) ? $message : null);
        $kind = $result['kind'];
        if ($kind === CommandKind::Write && isset($this->reads[$result['operation']])) {
            $kind = CommandKind::Read;
        }
        $this->guard->guard('firestore', $result['operation'], $kind);
        if ($kind === CommandKind::Session || !$this->guard->recorder()->isCapturing()) {
            return null;
        }
        $entry = ['system' => 'firestore', 'operation' => $result['operation']];
        $document = $this->documentOf($message);
        if ($document !== null) {
            $target = self::collectionOf($document);
            if ($target !== null) {
                $entry['target'] = $target;
            }
            $entry['statement'] = json_encode(Guard::sanitizeDocument($document), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: null;
        }

        return ['entry' => $entry, 'started' => hrtime(true)];
    }

    /** @param array<string,mixed>|null $pending */
    private function finish(?array $pending, ?string $error = null): void
    {
        if ($pending === null) {
            return;
        }
        $entry = $pending['entry'] + ['elapsedMs' => (hrtime(true) - $pending['started']) / 1e6];
        if ($error !== null) {
            $entry['error'] = $error;
        }
        $this->guard->recorder()->db($entry);
    }

    /** The request message in its JSON form (proto3 JSON), for the sanitized statement. */
    private function documentOf(mixed $message): \stdClass|array|null
    {
        try {
            $json = match (true) {
                $message instanceof \Google\Protobuf\Internal\Message => $message->serializeToJsonString(),
                is_array($message) || $message instanceof \stdClass => json_encode($message),
                default => null,
            };
            if ($json === null || $json === false || strlen($json) > self::LOG_LIMIT) {
                return null;
            }
            $decoded = json_decode($json);

            return $decoded instanceof \stdClass || is_array($decoded) ? $decoded : null;
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * The collection a request names, for `target`: the query's first `from`, a `collectionId`, or the
     * collection of the first document path the request carries.
     */
    private static function collectionOf(\stdClass|array $message): ?string
    {
        $message = json_decode(json_encode($message), true) ?: [];
        $from = $message['structuredQuery']['from'][0]['collectionId']
            ?? $message['structuredAggregationQuery']['structuredQuery']['from'][0]['collectionId']
            ?? $message['collectionId']
            ?? null;
        if (is_string($from) && $from !== '') {
            return $from;
        }
        $name = $message['name'] ?? $message['documents'][0] ?? $message['writes'][0]['update']['name'] ?? $message['writes'][0]['delete'] ?? null;
        if (!is_string($name) || !str_contains($name, '/documents/')) {
            return null;
        }
        $segments = array_values(array_filter(explode('/', explode('/documents/', $name, 2)[1])));

        return count($segments) >= 2 ? $segments[count($segments) - 2] : ($segments[0] ?? null);
    }
}
