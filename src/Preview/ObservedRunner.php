<?php

declare(strict_types=1);

namespace Sendproof\Core\Preview;

use Sendproof\Core\Capture\Clock;
use Sendproof\Core\Capture\Recorder;
use Sendproof\Core\Contracts\PreviewProvider;
use Sendproof\Core\Limits;
use Sendproof\Core\Protocol;
use Sendproof\Core\Trace\TraceStore;

/**
 * Watches an ordinary send, which commits normally, and stores an owner-only trace of it.
 *
 * Observed Send never alters the application's response. It only adds the trace header when a
 * complete trace was stored for a stable authenticated owner.
 */
final class ObservedRunner
{
    public function __construct(private readonly Recorder $recorder, private readonly TraceStore $store, private $report = null)
    {
    }

    /**
     * @template T
     * @param callable(): T $dispatch Runs the real request and returns the framework's response
     * @param callable(): ?string $currentOwner Resolves the owner key after the handler ran
     * @return array{0:T,1:array<string,string>} The untouched response and headers to add to it
     */
    public function run(PreviewProvider $provider, PreviewState $state, callable $dispatch, mixed $context, callable $currentOwner): array
    {
        $observation = null;
        try {
            $observation = $provider->beginObservation($context);
        } catch (\Throwable $error) {
            $this->report !== null && ($this->report)($error);
        }

        if ($observation === null) {
            return [$dispatch(), []];
        }

        $this->recorder->begin(false, $state->clock->start());
        $response = null;
        $headers = [];
        try {
            $response = $dispatch();
            $owner = $state->owner;
            if ($state->completed && $owner !== null && $owner === $currentOwner()) {
                $capture = $this->recorder->finish();
                $started = hrtime(true);
                [$changes, $truncated] = Limits::snapshotChanges($observation->changes());
                $this->recorder->addSerializeMs((hrtime(true) - $started) / 1e6);
                [$db, $queries, $serialize] = $this->recorder->counters();
                $timing = $state->clock->timing($db, $queries, $serialize);
                $trace = ['changes' => $changes, 'effects' => $capture['effects'], 'logs' => $capture['logs']];
                foreach (['changes' => $truncated || $observation->changesTruncated(), 'effects' => $capture['effectsTruncated'], 'logs' => $capture['logsTruncated']] as $name => $flag) {
                    if ($flag) {
                        $trace[$name . 'Truncated'] = true;
                    }
                }
                $trace['timing'] = $timing;
                $headers = [
                    Protocol::TRACE_HEADER => $this->store->put($owner, $trace),
                    'Cache-Control' => 'no-store',
                    'Server-Timing' => Clock::header($timing),
                ];
            }
        } catch (\Throwable $error) {
            if ($response === null) {
                throw $error;
            }
            $this->report !== null && ($this->report)($error);
            $headers = [];
        } finally {
            if ($this->recorder->isCapturing()) {
                $this->recorder->finish();
            }
            try {
                $observation->dispose();
            } catch (\Throwable $error) {
                $this->report !== null && ($this->report)($error);
            }
        }

        return [$response, $headers];
    }
}
