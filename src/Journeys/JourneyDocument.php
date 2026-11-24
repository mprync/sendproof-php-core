<?php

declare(strict_types=1);

namespace Sendproof\Core\Journeys;

use Sendproof\Core\Capabilities;

/** Builds one Arazzo document and its sibling expectations document from PHP definitions. */
final class JourneyDocument
{
    /** @var list<JourneyBuilder> */
    private array $journeys = [];
    private array $ignored = [];

    public function __construct(
        public readonly string $name,
        private readonly string $title,
        private readonly string $sourceName = 'api',
        private readonly string $version = '1.0.0',
    ) {
    }

    public function journey(string $id): JourneyBuilder
    {
        $journey = new JourneyBuilder($id);
        $this->journeys[] = $journey;

        return $journey;
    }

    public function ignore(array $target): self
    {
        $this->ignored[] = (object) $target;

        return $this;
    }

    /** @internal @return array{?array, list<string>} */
    public function build(string $openApiUrl, array|\stdClass $openApi): array
    {
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/D', $this->name)
            || trim($this->title) === '' || trim($this->version) === '' || !self::identifier($this->sourceName)
            || !Capabilities::isLocalUrl($openApiUrl)) {
            return [null, ['The document needs a valid filename, title, version, source name and local OpenAPI URL.']];
        }
        if ($this->journeys === []) {
            return [null, ['The document needs at least one journey.']];
        }

        try {
            $operations = self::operationIds($openApi);
            $ignored = self::snapshot($this->ignored);
        } catch (\JsonException|\InvalidArgumentException $error) {
            return [null, [$error->getMessage()]];
        }

        $workflows = $entries = $approvals = $seen = $problems = [];
        foreach ($this->journeys as $journey) {
            $workflow = $journey->workflow();
            $entry = $journey->expectations();
            $problemCount = count($problems);
            $id = $journey->id;
            if (!self::identifier($id) || isset($seen[$id])) {
                $problems[] = "Invalid or duplicate journey ID {$id}.";
                continue;
            }
            $seen[$id] = true;
            try {
                [$publishedWorkflow, $publishedEntry] = self::snapshot([$workflow, (object) $entry]);
                $journeyApprovals = self::snapshot((object) self::validate(
                    $journey, $publishedWorkflow, $publishedEntry, $operations, $approvals, $problems,
                ));
            } catch (\JsonException $error) {
                $problems[] = "{$id}: " . $error->getMessage();
                continue;
            }
            if (count($problems) !== $problemCount) {
                continue;
            }

            $workflows[] = $publishedWorkflow;
            if ($entry !== []) {
                $entries[$id] = $publishedEntry;
            }
            $approvals += (array) $journeyApprovals;
        }

        if ($workflows === []) {
            return [null, $problems];
        }

        $arazzo = (object) [
            'arazzo' => '1.1.0',
            'info' => ['title' => $this->title, 'version' => $this->version],
            'sourceDescriptions' => [(object) ['name' => $this->sourceName, 'url' => $openApiUrl, 'type' => 'openapi']],
            'workflows' => $workflows,
        ];
        $expectations = (object) [
            'sendproofExpectations' => '1.0',
            'arazzo' => $this->name . '.arazzo.json',
            'journeys' => (object) $entries,
        ];
        if ($ignored !== []) {
            $expectations->ignore = $ignored;
        }
        if ($approvals !== []) {
            $expectations->approvedDifferences = array_values($approvals);
        }

        return [['name' => $this->title, 'source' => 'code', 'arazzo' => $arazzo, 'expectations' => $expectations], $problems];
    }

    /** @internal */
    public static function identifier(string $value): bool
    {
        return preg_match('/^[a-zA-Z0-9_-]+$/D', $value) === 1;
    }

    /** Detaches the served data from mutable values supplied by the host. */
    private static function snapshot(mixed $value): mixed
    {
        return json_decode(json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION), flags: JSON_THROW_ON_ERROR);
    }

    private static function operationIds(array|\stdClass $openApi): array
    {
        $document = json_decode(json_encode($openApi, JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR);
        if (!is_string($document['openapi'] ?? null) || !is_array($document['paths'] ?? null)) {
            throw new \InvalidArgumentException('Expected the served OpenAPI document with its paths.');
        }
        $operations = [];
        foreach ($document['paths'] as $path) {
            if (is_string($path['$ref'] ?? null) && str_starts_with($path['$ref'], '#/')) {
                $target = $document;
                foreach (explode('/', substr(rawurldecode($path['$ref']), 2)) as $segment) {
                    $target = $target[str_replace(['~1', '~0'], ['/', '~'], $segment)] ?? null;
                }
                $path += is_array($target) ? $target : [];
            }
            foreach (['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'] as $method) {
                $id = $path[$method]['operationId'] ?? null;
                if (is_string($id) && $id !== '') {
                    $operations[$id] = ($operations[$id] ?? 0) + 1;
                }
            }
        }

        return $operations;
    }

    private static function validate(
        JourneyBuilder $journey,
        \stdClass $workflow,
        \stdClass $entry,
        array $operations,
        array $existingApprovals,
        array &$problems,
    ): array {
        $id = $journey->id;
        $inputs = (array) ($workflow->inputs->properties ?? []);
        foreach (array_keys($inputs) as $input) {
            if (!self::identifier((string) $input)) {
                $problems[] = "{$id}: Invalid input name {$input}.";
            }
        }
        if ($workflow->steps === []) {
            $problems[] = "{$id}: Define at least one step.";
        }
        if (isset($entry->sendOnlyReason) && trim($entry->sendOnlyReason) === '') {
            $problems[] = "{$id}: Send-only journeys need a reason.";
        }
        $outputs = $approvals = [];
        foreach ($journey->steps() as $index => $step) {
            $where = "{$id}.{$step->id}";
            if (!self::identifier($step->id) || array_key_exists($step->id, $outputs)) {
                $problems[] = "{$where}: Invalid or duplicate step ID.";
                continue;
            }
            $operationCount = $operations[$step->operationId] ?? 0;
            if ($operationCount !== 1) {
                $problem = $operationCount === 0 ? 'Unknown' : 'Ambiguous';
                $problems[] = "{$where}: {$problem} operationId {$step->operationId} in the OpenAPI document.";
            }
            foreach ($step->problems() as $problem) {
                $problems[] = "{$where}: {$problem}";
            }

            $definition = $workflow->steps[$index];
            foreach ($definition->parameters ?? [] as $parameter) {
                self::checkReferences($parameter->value, $inputs, $outputs, $where, $problems);
            }
            self::checkReferences($definition->requestBody->payload ?? null, $inputs, $outputs, $where, $problems);


            // Expectations are compared after this step has produced its outputs.
            $outputs[$step->id] = (array) ($definition->outputs ?? []);
            self::checkReferences($entry->steps->{$step->id} ?? [], $inputs, $outputs, $where, $problems);
            foreach ($step->approvals() as $approval) {
                $name = $approval['id'];
                if (trim($name) === '' || trim($approval['reason']) === '' || trim($approval['approvedBy']) === '') {
                    $problems[] = "{$where}: Approved differences need an ID, a reason and an approver.";
                    continue;
                }
                if (isset($approvals[$name]) || isset($existingApprovals[$name])) {
                    $problems[] = "{$where}: Approved difference {$name} already covers another expectation.";
                    continue;
                }
                $approvals[$name] = ['journey' => $id] + $approval;
            }
        }

        return $approvals;
    }

    private static function checkReferences(
        mixed $value,
        array $inputs,
        array $outputs,
        string $where,
        array &$problems,
    ): void {
        if (is_array($value) || $value instanceof \stdClass) {
            foreach ($value as $part) {
                self::checkReferences($part, $inputs, $outputs, $where, $problems);
            }
        } elseif (is_string($value)) {
            // Runtime expressions are either the whole value or an embedded template binding.
            preg_match_all('/(?:^|\{)(\$(?:inputs|steps)\.[a-zA-Z0-9_.-]*)/', $value, $matches);
            foreach ($matches[1] as $reference) {
                [$kind, $name, $section, $field] = array_pad(explode('.', $reference, 5), 4, null);
                if ($kind === '$inputs' && !array_key_exists($name, $inputs)) {
                    $problems[] = "{$where}: Unknown input {$name}.";
                } elseif ($kind === '$steps' && ($section !== 'outputs' || !isset($outputs[$name][$field]))) {
                    $problems[] = "{$where}: Invalid step output reference {$reference}.";
                }
            }
        }
    }
}
