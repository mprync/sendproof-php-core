<?php

declare(strict_types=1);

namespace Sendproof\Core\Journeys;

final class JourneyStep
{
    private array $step;
    private ?string $persona = null;
    private ?StepWrites $writes = null;
    private array $approvals = [];
    private array $problems = [];

    public function __construct(public readonly string $id, public readonly string $operationId)
    {
        $this->step = ['stepId' => $id, 'operationId' => $operationId];
    }

    public function runAs(string $persona): self
    {
        $this->persona = $persona;

        return $this;
    }

    public function set(string $name, mixed $value, string $in = 'path'): self
    {
        if (!in_array($in, ['path', 'query', 'header', 'cookie'], true)) {
            $this->problems[] = "Unsupported parameter location {$in}.";
        }
        $this->step['parameters']["{$in}:{$name}"] = ['name' => $name, 'in' => $in, 'value' => $value];

        return $this;
    }

    public function body(mixed $payload, string $contentType = 'application/json'): self
    {
        $this->step['requestBody'] = ['contentType' => $contentType, 'payload' => $payload];

        return $this;
    }

    /** Exposes a JSON Pointer in the step's response body. */
    public function output(string $name, string $pointer): self
    {
        if (!JourneyDocument::identifier($name) || ($pointer !== '' && !str_starts_with($pointer, '/'))) {
            $this->problems[] = "Invalid output {$name} or JSON Pointer {$pointer}.";
        }
        if (isset($this->step['outputs'][$name])) {
            $this->problems[] = "Duplicate output {$name}.";
        }
        $this->step['outputs'][$name] = '$response.body#' . $pointer;

        return $this;
    }

    public function ref(string $name): string
    {
        return Ref::output($this->id, $name);
    }

    public function succeedsWith(int $status): self
    {
        return $this->expectResponse('$statusCode == ' . $status);
    }

    public function expectResponse(string $condition): self
    {
        $this->step['successCriteria'][] = ['condition' => $condition];

        return $this;
    }

    /** @param callable(StepWrites):mixed $define */
    public function expectWrites(callable $define): self
    {
        $define($this->writes ??= new StepWrites());

        return $this;
    }

    /** Approves one difference on a field target such as ['store' => 'sqlite', 'table' => 'items', 'field' => 'name']. */
    public function approvedDifference(
        string $id,
        array $target,
        mixed $expected,
        mixed $actual,
        string $reason,
        string $approvedBy,
        string $approvedOn,
        ?string $expires = null,
        ?string $link = null,
    ): self {
        $approval = [
            'id' => $id, 'step' => $this->id, 'target' => (object) $target, 'kind' => 'value',
            'expected' => $expected, 'actual' => $actual, 'reason' => $reason,
            'approvedBy' => $approvedBy, 'approvedOn' => $approvedOn,
        ];
        if ($expires !== null) {
            $approval['expires'] = $expires;
        }
        if ($link !== null) {
            $approval['link'] = $link;
        }
        $this->approvals[] = $approval;

        return $this;
    }

    /** @internal */
    public function workflowStep(): array
    {
        $result = $this->step;
        if (isset($result['parameters'])) {
            $result['parameters'] = array_values($result['parameters']);
        }
        if (isset($result['outputs'])) {
            $result['outputs'] = (object) $result['outputs'];
        }

        return $result;
    }

    /** @internal */
    public function expectations(): array
    {
        return ($this->persona === null ? [] : ['persona' => $this->persona]) + ($this->writes?->entry() ?? []);
    }

    /** @internal */
    public function approvals(): array
    {
        return $this->approvals;
    }

    /** @internal */
    public function problems(): array
    {
        return $this->problems;
    }

    /** @internal */
    public function sendOnlyStore(): ?string
    {
        return $this->writes?->sendOnlyStore();
    }
}
