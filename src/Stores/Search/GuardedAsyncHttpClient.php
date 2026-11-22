<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Search;

use Http\Client\HttpAsyncClient;
use Http\Discovery\HttpAsyncClientDiscovery;
use Http\Promise\Promise;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * {@see GuardedHttpClient} for Elasticsearch's transport, which also sends through an HTTPlug
 * `HttpAsyncClient` when a client is in async mode. A refused write throws from `sendAsyncRequest()`
 * itself, before a promise exists, so the transport's retry chain never sees it and nothing is sent.
 */
final class GuardedAsyncHttpClient extends GuardedHttpClient implements HttpAsyncClient
{
    /**
     * @param ClientInterface|HttpAsyncClient $inner the client to decorate
     * @param HttpAsyncClient|null $async the asynchronous client to send through, when it isn't `$inner`
     */
    public function __construct(ClientInterface|HttpAsyncClient $inner, SearchGuard $search, private readonly ?HttpAsyncClient $async = null)
    {
        parent::__construct($inner instanceof ClientInterface ? $inner : new class ($inner) implements ClientInterface {
            public function __construct(private readonly HttpAsyncClient $async)
            {
            }

            public function sendRequest(RequestInterface $request): ResponseInterface
            {
                return $this->async->sendAsyncRequest($request)->wait();
            }
        }, $search);
    }

    public function sendAsyncRequest(RequestInterface $request): Promise
    {
        $pending = $this->search->beginRequest($request);
        $client = $this->async ?? ($this->inner instanceof HttpAsyncClient ? $this->inner : HttpAsyncClientDiscovery::find());

        return $client->sendAsyncRequest($request)->then(
            function (ResponseInterface $response) use ($pending): ResponseInterface {
                $this->search->finishResponse($pending, $response);

                return $response;
            },
            function (\Throwable $error) use ($pending): never {
                $this->search->finish($pending, null, null, (new \ReflectionClass($error))->getShortName());

                throw $error;
            },
        );
    }
}
