<?php

declare(strict_types=1);

namespace Sendproof\Core\Journeys;

final class JourneyBuilder
{
    private array $metadata = [];
    private ?string $summary = null;
    private ?string $description = null;
    private array $inputs = [];
    /** @var list<JourneyStep> */
    private array $steps = [];

    public function __construct(public readonly string $id)
    {
    }

    public function name(string $summary): self
    {
        return $this->summary($summary);
    }

    public function summary(string $summary): self
    {
        $this->summary = $summary;

        return $this;
    }

    public function description(string $description): self
    {
        $this->description = $description;

        return $this;
    }

    public function group(string $group): self
    {
        $this->metadata['group'] = $group;

        return $this;
    }

    public function runAs(string $persona): self
    {
        $this->metadata['runAs'] = $persona;

        return $this;
    }

    public function sendOnly(string $reason): self
    {
        $this->metadata['sendOnly'] = true;
        $this->metadata['sendOnlyReason'] = $reason;

        return $this;
    }

    public function definedIn(string $type, ?string $file = null): self
    {
        $this->metadata['definedIn'] = ['type' => $type] + ($file === null ? [] : ['file' => $file]);

        return $this;
    }

    /** Sets a full JSON Schema object, including one generated from a PHP DTO by the host. */
    public function inputs(array|\stdClass $schema): self
    {
        $this->inputs = (array) $schema;
        if (array_key_exists('properties', $this->inputs)) {
            $this->inputs['properties'] = (object) (array) $this->inputs['properties'];
        }

        return $this;
    }

    /** Defines one property with its JSON Schema, including optional default, format and constraints. */
    public function input(string $name, array $schema, bool $required = false): self
    {
        $this->inputs += ['type' => 'object', 'properties' => new \stdClass()];
        $this->inputs['properties']->{$name} = (object) $schema;
        if ($required) {
            $this->inputs['required'] = array_values(array_unique([...($this->inputs['required'] ?? []), $name]));
        }

        return $this;
    }

    public function step(string $id, string $operationId): JourneyStep
    {
        $step = new JourneyStep($id, $operationId);
        $this->steps[] = $step;

        return $step;
    }

    /** @internal */
    public function workflow(): array
    {
        $workflow = ['workflowId' => $this->id, 'summary' => $this->summary ?? $this->id];
        if ($this->description !== null) {
            $workflow['description'] = $this->description;
        }
        if ($this->inputs !== []) {
            $workflow['inputs'] = $this->inputs;
        }
        $workflow['steps'] = array_map(static fn (JourneyStep $step): array => $step->workflowStep(), $this->steps);

        return $workflow;
    }

    /** @internal */
    public function expectations(): array
    {
        $entry = $this->metadata;
        $steps = [];
        foreach ($this->steps as $step) {
            $expected = $step->expectations();
            if ($expected !== []) {
                $steps[$step->id] = $expected;
            }
            if (($store = $step->sendOnlyStore()) !== null && !isset($entry['sendOnly'])) {
                $entry['sendOnly'] = true;
                $entry['sendOnlyReason'] = "Step {$step->id} writes to {$store}, which cannot roll back.";
            }
        }

        return $entry === [] && $steps === [] ? [] : $entry + ['steps' => (object) $steps];
    }

    /** @internal @return list<JourneyStep> */
    public function steps(): array
    {
        return $this->steps;
    }
}
