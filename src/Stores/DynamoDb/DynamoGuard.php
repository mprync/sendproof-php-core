<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\DynamoDb;

use Aws\CommandInterface;
use Aws\DynamoDb\DynamoDbClient;
use Aws\Exception\AwsException;
use Aws\ResultInterface;
use GuzzleHttp\Promise\Create;
use Psr\Http\Message\RequestInterface;
use Sendproof\Core\Stores\Classifier;
use Sendproof\Core\Stores\Guard;

/**
 * Write guard for DynamoDB (spec/data-stores.md, `guard` mode).
 *
 * {@see install()} adds one middleware to the AWS SDK client's handler list at the `init` step,
 * which runs before validation, serialisation and signing, so a refused command never becomes an
 * HTTP request, and credentials, the `Authorization` header and signatures never reach the hook.
 * The operation is the command name (`UpdateItem`). The document-style helpers
 * (`Aws\DynamoDb\Marshaler`, `WriteRequestBatch`, the session handler) all send through the client,
 * so hooking the client covers them. A client created separately is not covered.
 */
final class DynamoGuard
{
    private const MIDDLEWARE = 'sendproof.write-guard';

    /** @var \WeakMap<object,true>|null */
    private static ?\WeakMap $hooked = null;

    /**
     * Hooks `$client` in place. Hooking a client twice is a no-op, so its commands are never logged twice.
     *
     * @param array<string,true>|null $reads host-declared read action names, matched exactly
     */
    public static function install(DynamoDbClient $client, Guard $guard, ?array $reads = null): void
    {
        self::$hooked ??= new \WeakMap();
        if (isset(self::$hooked[$client])) {
            return;
        }
        self::$hooked[$client] = true;

        $client->getHandlerList()->appendInit(static function (callable $handler) use ($guard, $reads): callable {
            return static function (CommandInterface $command, ?RequestInterface $request = null) use ($handler, $guard, $reads) {
                $operation = $command->getName();
                $input = $command->toArray();
                try {
                    $guard->guard('dynamodb', $operation, Classifier::dynamo($operation, $input, $reads));
                } catch (\Throwable $refusal) {
                    // An asynchronous caller gets a rejected promise; `wait()` rethrows it.
                    return Create::rejectionFor($refusal);
                }

                $recorder = $guard->recorder();
                if (!$recorder->isCapturing()) {
                    return $handler($command, $request);
                }
                $statement = self::statementOf($input);
                $entry = ['system' => 'dynamodb', 'operation' => $operation, 'target' => self::targetOf($input, $statement), 'statement' => $statement];
                $started = hrtime(true);

                return $handler($command, $request)->then(
                    static function ($result) use ($guard, $entry, $started) {
                        $guard->recorder()->db($entry + ['rowsAffected' => self::rowsOf($result), 'elapsedMs' => (hrtime(true) - $started) / 1e6]);

                        return $result;
                    },
                    static function ($reason) use ($guard, $entry, $started) {
                        $code = $reason instanceof AwsException ? ($reason->getAwsErrorCode() ?? 'Error') : (new \ReflectionClass($reason))->getShortName();
                        $guard->recorder()->db($entry + ['error' => $code, 'elapsedMs' => (hrtime(true) - $started) / 1e6]);

                        return Create::rejectionFor($reason);
                    },
                );
            };
        }, self::MIDDLEWARE);
    }

    /**
     * Replaces every literal in PartiQL text with `?`: single-quoted strings (with `''` escapes)
     * and numbers. Double-quoted identifiers (table and attribute names) are kept as written. A
     * statement may inline values instead of using `?` parameters, and a value never appears in a
     * `Db` entry.
     */
    public static function sanitizePartiql(string $text): string
    {
        $out = '';
        $length = strlen($text);
        for ($index = 0; $index < $length;) {
            $char = $text[$index];
            if ($char === '"') {
                $end = strpos($text, '"', $index + 1);
                $stop = $end === false ? $length : $end + 1;
                $out .= substr($text, $index, $stop - $index);
                $index = $stop;
            } elseif ($char === "'") {
                $end = $index + 1;
                while ($end < $length && !($text[$end] === "'" && ($text[$end + 1] ?? '') !== "'")) {
                    $end += $text[$end] === "'" ? 2 : 1;
                }
                $out .= '?';
                $index = $end + 1;
            } elseif (ctype_digit($char) && ($index === 0 || preg_match('/[\w.]/', $text[$index - 1]) !== 1)) {
                preg_match('/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/', substr($text, $index), $number);
                $out .= '?';
                $index += strlen($number[0]);
            } else {
                $out .= $char;
                $index++;
            }
        }

        return $out;
    }

    /**
     * The PartiQL text of a request, with literals replaced by `?`; other actions have no statement.
     *
     * @param array<string,mixed> $input
     */
    private static function statementOf(array $input): ?string
    {
        if (isset($input['Statement']) && is_string($input['Statement'])) {
            return self::sanitizePartiql($input['Statement']);
        }
        $list = $input['Statements'] ?? $input['TransactStatements'] ?? null;
        if (!is_array($list)) {
            return null;
        }

        return implode('; ', array_map(static fn ($item): string => self::sanitizePartiql((string) (is_array($item) ? ($item['Statement'] ?? '') : '')), $list));
    }

    /**
     * The table a command targets: `TableName`, the first `RequestItems` table, or the quoted PartiQL table.
     *
     * @param array<string,mixed> $input
     */
    private static function targetOf(array $input, ?string $statement): ?string
    {
        if (isset($input['TableName']) && is_string($input['TableName'])) {
            return $input['TableName'];
        }
        if (isset($input['RequestItems']) && is_array($input['RequestItems']) && $input['RequestItems'] !== []) {
            return (string) array_key_first($input['RequestItems']);
        }

        return $statement !== null && preg_match('/"([^"]+)"/', $statement, $match) === 1 ? $match[1] : null;
    }

    /** Items matched, returned or written, when the reply says so. */
    private static function rowsOf(mixed $result): ?int
    {
        if (!$result instanceof ResultInterface) {
            return null;
        }
        if (is_array($result['Items'])) {
            return count($result['Items']);
        }
        if (is_int($result['Count'])) {
            return $result['Count'];
        }

        return $result['Item'] !== null || $result['Attributes'] !== null ? 1 : null;
    }
}
