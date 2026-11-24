<?php

declare(strict_types=1);

namespace Sendproof\Core\Journeys;

final class StepWrites
{
    /** @var list<array<string,mixed>> */
    private array $writes = [];
    /** @var list<array<string,mixed>> */
    private array $effects = [];
    private bool $expectsNothing = false;
    private ?string $sendOnlyStore = null;

    public function sql(string $store, string $table, string $op, array $values = [], array $key = []): self
    {
        return $this->write($store, $op, ['table' => $table] + ($key === [] ? [] : ['key' => (object) $key]), $values);
    }

    public function mongo(string $collection, string $op, array $values = [], array $key = []): self
    {
        return $this->write('mongodb', $op, ['collection' => $collection] + ($key === [] ? [] : ['key' => (object) $key]), $values);
    }

    public function redis(string $key, string $op, array $values = []): self
    {
        return $this->write('redis', strtoupper($op), ['key' => $key], $values);
    }

    /** Describes writes to other hooked stores using the target fields reported by that store. */
    public function write(string $store, string $op, array $target, array $values = []): self
    {
        $write = ['store' => $store, 'op' => $op] + $target;
        if ($values !== []) {
            $write['values'] = (object) $values;
        }
        $this->writes[] = $write;
        if (in_array($store, ['redis', 'dynamodb', 'elasticsearch', 'opensearch', 'firestore'], true)) {
            $this->sendOnlyStore ??= $store;
        }

        return $this;
    }

    public function email(mixed $to, mixed $subject): self
    {
        return $this->effect('email', ['to' => $to, 'subject' => $subject]);
    }

    public function effect(string $kind, array $data): self
    {
        $this->effects[] = ['kind' => $kind] + $data;

        return $this;
    }

    public function nothing(): self
    {
        $this->expectsNothing = true;

        return $this;
    }

    /** @internal */
    public function entry(): array
    {
        $entry = ['writes' => $this->writes, 'unlisted' => 'fail'];
        if ($this->effects !== [] || $this->expectsNothing) {
            $entry['effects'] = $this->effects;
        }

        return $entry;
    }

    /** @internal */
    public function sendOnlyStore(): ?string
    {
        return $this->sendOnlyStore;
    }
}
