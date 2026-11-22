<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

use Sendproof\Core\Capture\Recorder;

/**
 * A store with no transaction to manage (Redis, DynamoDB): its hook refuses writes inside the
 * client, so the store only describes itself for discovery.
 */
final class GuardOnlyStore implements DataStore
{
    public function __construct(private readonly string $system, private readonly ?string $name = null)
    {
    }

    public function system(): string
    {
        return $this->system;
    }

    public function describe(): array
    {
        return ['system' => $this->system] + ($this->name === null ? [] : ['name' => $this->name]) + ['mode' => 'guard'];
    }

    public function begin(Recorder $recorder): void
    {
    }

    public function finish(Recorder $recorder): void
    {
    }
}
