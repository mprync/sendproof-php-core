<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Search;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * A PSR-18 client that asks the {@see SearchGuard} about every request before the client it decorates
 * sends it. A refused write throws `PreviewWriteBlockedException` and nothing reaches the network.
 *
 * Pass it to `Elastic\Elasticsearch\ClientBuilder::setHttpClient()`, or to OpenSearch's
 * `TransportFactory::setHttpClient()`; {@see ElasticsearchGuard::install()} and
 * {@see OpenSearchGuard::install()} put it into a client that already exists.
 */
class GuardedHttpClient implements ClientInterface
{
    public function __construct(protected readonly ClientInterface $inner, protected readonly SearchGuard $search)
    {
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $pending = $this->search->beginRequest($request);
        try {
            $response = $this->inner->sendRequest($request);
        } catch (\Throwable $error) {
            $this->search->finish($pending, null, null, (new \ReflectionClass($error))->getShortName());

            throw $error;
        }
        $this->search->finishResponse($pending, $response);

        return $response;
    }

    /** The client this one decorates. */
    public function inner(): ClientInterface
    {
        return $this->inner;
    }
}
