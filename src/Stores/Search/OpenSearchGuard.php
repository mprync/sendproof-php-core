<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Search;

use OpenSearch\Client;
use OpenSearch\ConnectionPool\AbstractConnectionPool;
use OpenSearch\ConnectionPool\SniffingConnectionPool;
use OpenSearch\Connections\Connection;
use OpenSearch\Connections\ConnectionFactory;
use OpenSearch\HttpTransport;
use OpenSearch\LegacyTransportWrapper;
use OpenSearch\Transport;
use Psr\Http\Client\ClientInterface;
use Sendproof\Core\Stores\Guard;
use Sendproof\Core\Stores\InternalProperty;

/**
 * Write guard for `opensearch-project/opensearch-php` 2 (spec/data-stores.md, `guard` mode). The
 * library has two ways to send, and both end in one function that sees the request before any byte
 * leaves the process:
 *
 * - The PSR-18 transport (`OpenSearch\GuzzleClientFactory`, `SymfonyClientFactory`, `TransportFactory`):
 *   the HTTP client is decorated with {@see GuardedHttpClient}.
 * - The legacy RingPHP transport (`ClientBuilder`, deprecated since 2.4): the handler of every
 *   connection, and of the factory that makes more, is wrapped in a {@see GuardedRingHandler}.
 *
 * {@see install()} puts the guard into a client that already exists, whichever way it was built, and
 * so into everything that holds its transport (`$client->indices()`, `->cat()`, the helpers). A client
 * with a transport of another kind is refused, never left unguarded. {@see httpClient()} and
 * {@see handler()} are for building a client from scratch. A second client built elsewhere is not covered.
 */
final class OpenSearchGuard
{
    private const WHAT = 'an OpenSearch client';

    /** @var \WeakMap<object,true>|null */
    private static ?\WeakMap $hooked = null;

    /**
     * Hooks `$client` in place. Hooking a client twice is a no-op, so its requests are never logged twice.
     *
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     * @param string|null $pathPrefix a path the client's hosts carry that the shared table doesn't know
     *        (legacy transport only: the PSR-18 transport adds its base path below the guard)
     * @throws \LogicException when the client sends through a transport this guard can't decorate
     */
    public static function install(Client $client, Guard $guard, ?array $reads = null, ?string $pathPrefix = null): void
    {
        self::$hooked ??= new \WeakMap();
        if (isset(self::$hooked[$client])) {
            return;
        }
        // The library keeps every piece the hook replaces in non-public properties with no setters. If a
        // release moves one, InternalProperty refuses to start rather than leave the client unguarded.
        $http = InternalProperty::read($client, Client::class, 'httpTransport', self::WHAT);
        if ($http instanceof HttpTransport) {
            $search = new SearchGuard($guard, 'opensearch', $reads, $pathPrefix === null ? [] : [$pathPrefix]);
            InternalProperty::replace($http, HttpTransport::class, 'client', static fn (mixed $current): mixed => $current instanceof GuardedHttpClient
                ? $current
                : new GuardedHttpClient($current instanceof ClientInterface ? $current : throw new \LogicException(sprintf('Sendproof can\'t guard %s: its transport holds a %s, not a PSR-18 client.', self::WHAT, get_debug_type($current))), $search), self::WHAT);
        } elseif ($http instanceof LegacyTransportWrapper) {
            $transport = InternalProperty::read($http, LegacyTransportWrapper::class, 'transport', self::WHAT);
            if (!$transport instanceof Transport) {
                throw new \LogicException(sprintf('Sendproof can\'t guard %s: its legacy transport is a %s.', self::WHAT, get_debug_type($transport)));
            }
            self::installLegacy($transport, $guard, $reads, $pathPrefix);
        } else {
            throw new \LogicException(sprintf('Sendproof can\'t guard an OpenSearch client with a %s transport. Build the client with OpenSearch\GuzzleClientFactory, SymfonyClientFactory or ClientBuilder, or decorate its HTTP client with Sendproof\Core\Stores\Search\GuardedHttpClient.', get_debug_type($http)));
        }
        self::$hooked[$client] = true;
    }

    /**
     * The guarded HTTP client for a client built from the PSR-18 transport: give it to
     * `OpenSearch\TransportFactory::setHttpClient()`.
     *
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     */
    public static function httpClient(ClientInterface $inner, Guard $guard, ?array $reads = null): GuardedHttpClient
    {
        return new GuardedHttpClient($inner, new SearchGuard($guard, 'opensearch', $reads));
    }

    /**
     * The guarded handler for a client built with the legacy `ClientBuilder`: pass it to
     * `ClientBuilder::setHandler()`, wrapping `ClientBuilder::defaultHandler()` or your own.
     *
     * @param array<string,true>|null $reads host-declared read operation names, matched exactly
     * @param string|null $pathPrefix a path the client's hosts carry, such as `/search`
     */
    public static function handler(callable $inner, Guard $guard, ?array $reads = null, ?string $pathPrefix = null): GuardedRingHandler
    {
        return new GuardedRingHandler($inner, new SearchGuard($guard, 'opensearch', $reads, $pathPrefix === null ? [] : [$pathPrefix]));
    }

    /** Wraps every connection of the legacy transport, and the factory that creates the next ones. */
    private static function installLegacy(Transport $transport, Guard $guard, ?array $reads, ?string $pathPrefix): void
    {
        $pool = $transport->connectionPool;
        if (!$pool instanceof AbstractConnectionPool) {
            throw new \LogicException(sprintf('Sendproof can\'t guard %s whose connection pool is a %s: it can\'t reach the connections.', self::WHAT, get_debug_type($pool)));
        }
        $global = $pathPrefix === null ? [] : [$pathPrefix];
        $connections = [
            ...(array) InternalProperty::read($pool, AbstractConnectionPool::class, 'connections', self::WHAT),
            ...(array) InternalProperty::read($pool, AbstractConnectionPool::class, 'seedConnections', self::WHAT),
        ];
        foreach ($connections as $connection) {
            if (!$connection instanceof Connection) {
                throw new \LogicException(sprintf('Sendproof can\'t guard %s whose connection pool holds a %s.', self::WHAT, get_debug_type($connection)));
            }
            $path = InternalProperty::read($connection, Connection::class, 'path', self::WHAT);
            $prefixes = [...$global, ...(is_string($path) && $path !== '' ? [$path] : [])];
            // A connection reached through both lists, or hooked by an earlier call, is wrapped once.
            InternalProperty::replace($connection, Connection::class, 'handler', static fn (mixed $handler): mixed => self::wrap($handler, $guard, $reads, $prefixes), self::WHAT);
        }
        $factory = InternalProperty::read($pool, AbstractConnectionPool::class, 'connectionFactory', self::WHAT);
        if ($factory instanceof ConnectionFactory) {
            // Connections created later get the guarded handler.
            InternalProperty::replace($factory, ConnectionFactory::class, 'handler', static fn (mixed $handler): mixed => self::wrap($handler, $guard, $reads, $global), self::WHAT);
        } elseif ($pool instanceof SniffingConnectionPool) {
            throw new \LogicException(sprintf('Sendproof can\'t guard %s whose sniffing pool uses a custom connection factory: the connections it discovers would send unguarded.', self::WHAT));
        }
    }

    /**
     * @param array<string,true>|null $reads
     * @param list<string> $prefixes
     */
    private static function wrap(mixed $handler, Guard $guard, ?array $reads, array $prefixes): GuardedRingHandler
    {
        if ($handler instanceof GuardedRingHandler) {
            return $handler;
        }
        if (!is_callable($handler)) {
            throw new \LogicException(sprintf('Sendproof can\'t guard %s: a connection holds a %s, not a RingPHP handler.', self::WHAT, get_debug_type($handler)));
        }

        return new GuardedRingHandler($handler, new SearchGuard($guard, 'opensearch', $reads, $prefixes));
    }
}
