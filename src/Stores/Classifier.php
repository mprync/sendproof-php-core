<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

/**
 * Write classification for the batch-one data stores, driven by the shared tables in
 * spec/data-stores/ (embedded in {@see Tables}). Each table lists reads and connection-level
 * commands; everything else, including a command the table has never heard of, is a write, so the
 * guard fails closed when a store adds a command.
 *
 * Every method is pure. The shared vectors in spec/data-stores/classification-cases.json run
 * through them in core/tests/StoreClassifierTest.php.
 */
final class Classifier
{
    /** @var array<string,array<string,true>>|null */
    private static ?array $redis = null;
    /** @var array<string,mixed>|null */
    private static ?array $mongo = null;
    /** @var array<string,mixed>|null */
    private static ?array $dynamo = null;
    /** @var array<string,mixed>|null */
    private static ?array $search = null;
    /** @var array<string,mixed>|null */
    private static ?array $firestore = null;

    /**
     * Classifies a Redis command. `$name` is the command name in any case and `$args` its arguments,
     * of which only the first is read, to form `CONTAINER|SUBCOMMAND` keys such as `OBJECT|ENCODING`.
     * `$treatAsRead` holds host-declared reads, compared exactly against the upper-case key.
     *
     * @param list<mixed> $args
     * @param array<string,true>|null $treatAsRead see {@see Guard::readSet()}
     */
    public static function redis(string $name, array $args = [], ?array $treatAsRead = null): CommandKind
    {
        $tables = self::$redis ??= self::loadRedis();
        $command = strtoupper($name);
        $keys = [$command];
        if ($args !== [] && (is_string($args[0]) || is_int($args[0]) || $args[0] instanceof \Stringable)) {
            array_unshift($keys, $command . '|' . strtoupper((string) $args[0]));
        }
        foreach ($keys as $key) {
            if (isset($tables['session'][$key])) {
                return CommandKind::Session;
            }
            if (isset($tables['transaction'][$key])) {
                return CommandKind::Transaction;
            }
            if (isset($tables['read'][$key]) || isset($treatAsRead[$key])) {
                return CommandKind::Read;
            }
        }

        return CommandKind::Write;
    }

    /**
     * Classifies a MongoDB command document by its first key, case-insensitively. `aggregate` is a
     * write when any stage at any depth (sub-pipelines included) is `$out` or `$merge`; `explain`
     * takes the classification of the command inside it. `refusedInTransaction` names what a
     * `preview`-mode Preview must block first, such as `$out` or `count`.
     * `$treatAsRead` holds host-declared reads in lower case.
     *
     * @param array<string,mixed>|object $command
     * @param array<string,true>|null $treatAsRead
     * @return array{kind:CommandKind,refusedInTransaction:?string}
     */
    public static function mongo(array|object $command, ?array $treatAsRead = null): array
    {
        $tables = self::$mongo ??= self::loadMongo();
        $document = self::asArray($command) ?? [];
        $name = (string) (array_key_first($document) ?? '');
        $lower = strtolower($name);
        if ($lower === 'explain' && ($inner = self::asArray($document[$name])) !== null) {
            return self::mongo($inner, $treatAsRead);
        }

        $refused = isset($tables['notInTransaction'][$lower]) ? $name : null;
        $pipeline = $lower === 'aggregate' ? ($document['pipeline'] ?? null) : null;
        if ($lower === 'aggregate') {
            foreach ($tables['stages'] as $stage) {
                if (self::pipelineUses($pipeline, [$stage => true])) {
                    $refused = $stage;
                    break;
                }
            }
        }
        $result = static fn (CommandKind $kind): array => ['kind' => $kind, 'refusedInTransaction' => $refused];

        if (isset($tables['session'][$lower])) {
            return ['kind' => CommandKind::Session, 'refusedInTransaction' => null];
        }
        if ($lower === 'aggregate' && self::pipelineUses($pipeline, ['$out' => true, '$merge' => true])) {
            return $result(CommandKind::Write);
        }
        if (isset($tables['read'][$lower]) || isset($treatAsRead[$lower])) {
            return $result(CommandKind::Read);
        }

        return $result(CommandKind::Write);
    }

    /**
     * Skips whitespace and SQL-style comments, then returns the first word of a PartiQL statement
     * in upper case. An unterminated block comment yields an empty string, which is not `SELECT`.
     */
    public static function partiqlVerb(mixed $statement): string
    {
        $text = is_scalar($statement) || $statement instanceof \Stringable ? (string) $statement : '';
        while (true) {
            $trimmed = ltrim($text);
            if (str_starts_with($trimmed, '--')) {
                $end = strpos($trimmed, "\n");
                $text = $end === false ? '' : substr($trimmed, $end + 1);
                continue;
            }
            if (str_starts_with($trimmed, '/*')) {
                $end = strpos($trimmed, '*/');
                if ($end === false) {
                    return '';
                }
                $text = substr($trimmed, $end + 2);
                continue;
            }

            return preg_match('/^[A-Za-z]+/', $trimmed, $match) === 1 ? strtoupper($match[0]) : '';
        }
    }

    /**
     * Classifies a DynamoDB action and its input as read or write. A PartiQL request is a read only
     * when every statement in it is a `SELECT`. `$treatAsRead` holds host-declared action names.
     *
     * @param array<string,mixed> $input
     * @param array<string,true>|null $treatAsRead
     */
    public static function dynamo(string $operation, array $input = [], ?array $treatAsRead = null): CommandKind
    {
        $tables = self::$dynamo ??= self::loadDynamo();
        if (isset($tables['read'][$operation]) || isset($treatAsRead[$operation])) {
            return CommandKind::Read;
        }
        if (isset($tables['partiql'][$operation])) {
            $statements = [];
            if ($operation === 'ExecuteStatement') {
                $statements = [$input['Statement'] ?? null];
            } else {
                $list = $input['Statements'] ?? $input['TransactStatements'] ?? null;
                foreach (is_array($list) ? $list : [] as $item) {
                    $statements[] = is_array($item) ? ($item['Statement'] ?? null) : null;
                }
            }
            foreach ($statements as $statement) {
                if (self::partiqlVerb($statement) !== 'SELECT') {
                    return CommandKind::Write;
                }
            }

            return $statements === [] ? CommandKind::Write : CommandKind::Read;
        }

        return CommandKind::Write;
    }

    /**
     * Classifies an Elasticsearch or OpenSearch request by HTTP method and path (the SQL endpoints
     * also by body), driven by `elasticsearch.json`: the first endpoint entry whose method and path
     * match decides, `GET` and `HEAD` are reads on every other path, and everything else is a write.
     * Segments are compared after percent-decoding, with repeated and trailing slashes dropped and
     * the query string ignored. `operation` is the endpoint's name (`update_by_query`), or the method
     * and the path with every non-underscore segment replaced by `{}` (`PUT /{}`) for an unlisted one.
     *
     * @param string|array<mixed>|object|\Closure|null $body the request body: JSON text, the decoded
     *        document, or a closure that returns either, called only for a SQL endpoint, so a large
     *        `_bulk` body is never read just to classify it
     * @return array{kind:CommandKind,operation:string}
     */
    public static function elasticsearch(string $method, string $path, string|array|object|null $body = null): array
    {
        $table = self::$search ??= self::loadSearch();
        $verb = strtoupper($method);
        $segments = self::pathSegments($path);
        foreach ($table['endpoints'] as $entry) {
            if (!in_array($verb, $entry['methods'], true)) {
                continue;
            }
            foreach ($entry['patterns'] as $pattern) {
                if (count($pattern) !== count($segments) || !self::segmentsMatch($pattern, $segments)) {
                    continue;
                }
                $kind = match ($entry['kind']) {
                    'read' => CommandKind::Read,
                    'session' => CommandKind::Session,
                    'sql' => self::sqlRequestReads($body, $table['sqlReadWords']) ? CommandKind::Read : CommandKind::Write,
                    default => CommandKind::Write,
                };

                return ['kind' => $kind, 'operation' => $entry['name']];
            }
        }
        $operation = $verb . ' /' . implode('/', array_map(static fn (string $segment): string => str_starts_with($segment, '_') ? $segment : '{}', $segments));

        return ['kind' => ($table['methodDefault'][$verb] ?? 'write') === 'read' ? CommandKind::Read : CommandKind::Write, 'operation' => $operation];
    }

    /** The index a search request names (its first segment, unless that is an endpoint), for `target`. */
    public static function elasticsearchTarget(string $path): ?string
    {
        $first = self::pathSegments($path)[0] ?? null;

        return $first !== null && !str_starts_with($first, '_') ? $first : null;
    }

    /**
     * Classifies a Firestore RPC by method name, driven by `firestore.json`. `$rpc` is the gRPC path
     * (`/google.firestore.v1.Firestore/Commit`) or a bare v1 method name. `$message` is the request
     * when the hook can read it (a protobuf message, or its decoded JSON): a `Commit` with no writes
     * only ends a transaction that wrote nothing and is a session command; without a readable
     * message every `Commit` is a write. A method of another service or API version is a write.
     *
     * @param array<mixed>|object|null $message
     * @return array{kind:CommandKind,operation:string}
     */
    public static function firestore(string $rpc, array|object|null $message = null): array
    {
        $table = self::$firestore ??= Tables::firestore()['services'];
        $parts = str_contains($rpc, '/') ? array_values(array_filter(explode('/', $rpc), static fn (string $part): bool => $part !== '')) : ['google.firestore.v1.Firestore', $rpc];
        [$service, $operation] = [$parts[0] ?? '', $parts[1] ?? ''];
        $known = $table[$service] ?? null;
        if ($known === null) {
            return ['kind' => CommandKind::Write, 'operation' => $operation];
        }
        if (isset($known['readPrefixes'])) {
            foreach ($known['readPrefixes'] as $prefix) {
                if (str_starts_with($operation, $prefix)) {
                    return ['kind' => CommandKind::Read, 'operation' => $operation];
                }
            }

            return ['kind' => CommandKind::Write, 'operation' => $operation];
        }
        if ($operation === 'Commit') {
            $writes = self::firestoreWrites($message);

            return ['kind' => $writes === 0 ? CommandKind::Session : CommandKind::Write, 'operation' => $operation];
        }
        if (in_array($operation, $known['read'], true)) {
            return ['kind' => CommandKind::Read, 'operation' => $operation];
        }
        if (in_array($operation, $known['session'], true)) {
            return ['kind' => CommandKind::Session, 'operation' => $operation];
        }

        return ['kind' => CommandKind::Write, 'operation' => $operation];
    }

    /**
     * The v1 method a Firestore REST request stands for (`fromRest` in `firestore.json`), for a hook
     * on the REST transport. An unknown `:verb`, or a method with no matching rule, names itself and
     * so classifies as a write.
     */
    public static function firestoreRpcFromRest(string $method, string $path): string
    {
        $verbs = Tables::firestore()['fromRest']['verbs'];
        $segments = self::pathSegments($path);
        $last = $segments === [] ? '' : $segments[array_key_last($segments)];
        $colon = strrpos($last, ':');
        if ($colon !== false) {
            $verb = substr($last, $colon + 1);

            return $verbs[$verb] ?? $verb;
        }
        $documents = array_search('documents', $segments, true);
        $after = $documents === false ? 0 : count($segments) - ($documents + 1);
        $isDocument = $documents !== false && $after > 0 && $after % 2 === 0;
        $verb = strtoupper($method);

        return match ($verb) {
            'GET' => $isDocument ? 'GetDocument' : 'ListDocuments',
            'PATCH' => 'UpdateDocument',
            'DELETE' => 'DeleteDocument',
            'POST' => $isDocument ? 'POST' : 'CreateDocument',
            default => $verb,
        };
    }

    /**
     * The number of writes a Firestore request message carries, or null when the message can't be read.
     *
     * @param array<mixed>|object|null $message
     */
    private static function firestoreWrites(array|object|null $message): ?int
    {
        if ($message instanceof \stdClass) {
            $message = (array) $message;
        }
        if (is_array($message)) {
            $writes = $message['writes'] ?? [];

            return is_array($writes) ? count($writes) : null;
        }
        if (is_object($message) && method_exists($message, 'getWrites')) {
            $writes = $message->getWrites();

            return is_countable($writes) ? count($writes) : null;
        }

        return null;
    }

    /**
     * Splits a request path into percent-decoded segments, without the query string, repeated
     * slashes or a trailing slash.
     *
     * @return list<string>
     */
    private static function pathSegments(string $path): array
    {
        $path = explode('?', $path, 2)[0];

        return array_values(array_map(rawurldecode(...), array_filter(explode('/', $path), static fn (string $part): bool => $part !== '')));
    }

    /**
     * @param list<string> $pattern
     * @param list<string> $segments
     */
    private static function segmentsMatch(array $pattern, array $segments): bool
    {
        foreach ($pattern as $index => $part) {
            $segment = $segments[$index];
            $matches = match ($part) {
                '{index}' => $segment !== '' && !str_starts_with($segment, '_'),
                '{id}' => $segment !== '',
                default => $part === $segment,
            };
            if (!$matches) {
                return false;
            }
        }

        return true;
    }

    /**
     * Whether an Elasticsearch or OpenSearch SQL request is a read: its `query` holds one statement
     * starting with a read word, or it only fetches the next page of a cursor. Text that isn't JSON,
     * a query only in the URL, an unterminated quote or comment, or a second statement is a write.
     *
     * @param array<string,true> $readWords
     */
    private static function sqlRequestReads(string|array|object|null $body, array $readWords): bool
    {
        if ($body instanceof \Closure) {
            $body = $body();
        }
        $parsed = is_string($body) ? json_decode($body, true) : self::asArray($body);
        if (!is_array($parsed)) {
            return false;
        }
        if (isset($parsed['query']) && is_string($parsed['query'])) {
            $shape = self::statementShape($parsed['query']);

            return !$shape['broken'] && !$shape['multiple'] && isset($readWords[$shape['first']]);
        }

        return !array_key_exists('query', $parsed) && isset($parsed['cursor']) && is_string($parsed['cursor']);
    }

    /**
     * Reads the shape of one SQL statement the way the server would: its first word in upper case
     * (after whitespace and `--` and block comments), and whether anything but whitespace and
     * comments follows a semicolon outside quotes. `broken` is set for an unterminated quote or
     * comment. Quotes are `'…'`, `"…"` and backticks, with doubled-quote escapes.
     *
     * @return array{first:string,multiple:bool,broken:bool}
     */
    public static function statementShape(string $source): array
    {
        $length = strlen($source);
        $index = 0;
        // Moves past one comment at $index; false when there is none, null for an unterminated one.
        $comment = static function () use ($source, $length, &$index): ?bool {
            if (substr($source, $index, 2) === '--') {
                $end = strpos($source, "\n", $index);
                $index = $end === false ? $length : $end + 1;

                return true;
            }
            if (substr($source, $index, 2) === '/*') {
                $end = strpos($source, '*/', $index + 2);
                if ($end === false) {
                    return null;
                }
                $index = $end + 2;

                return true;
            }

            return false;
        };
        $broken = ['first' => '', 'multiple' => false, 'broken' => true];
        // Skip whitespace and comments, then read the first word.
        while (true) {
            while ($index < $length && ctype_space($source[$index])) {
                $index++;
            }
            $skipped = $comment();
            if ($skipped === null) {
                return $broken;
            }
            if (!$skipped) {
                break;
            }
        }
        $first = preg_match('/\G[A-Za-z_]+/', $source, $match, 0, $index) === 1 ? strtoupper($match[0]) : '';
        $index += strlen($match[0] ?? '');
        $multiple = false;
        while ($index < $length) {
            $skipped = $comment();
            if ($skipped === null) {
                return $broken;
            }
            if ($skipped) {
                continue;
            }
            $char = $source[$index];
            if ($char === "'" || $char === '"' || $char === '`') {
                $end = $index + 1;
                while (true) {
                    $end = strpos($source, $char, $end);
                    if ($end === false) {
                        return $broken;
                    }
                    if (($source[$end + 1] ?? '') === $char) {
                        $end += 2;
                        continue;
                    }
                    break;
                }
                $index = $end + 1;
                continue;
            }
            $index++;
            if ($char === ';') {
                // Only whitespace and comments may follow the first statement's semicolon.
                while (true) {
                    while ($index < $length && ctype_space($source[$index])) {
                        $index++;
                    }
                    $skipped = $comment();
                    if ($skipped === null) {
                        return $broken;
                    }
                    if (!$skipped) {
                        break;
                    }
                }
                $multiple = $index < $length;
                break;
            }
        }

        return ['first' => $first, 'multiple' => $multiple, 'broken' => false];
    }

    /** @return array<string,mixed> */
    private static function loadSearch(): array
    {
        $table = Tables::elasticsearch();
        $endpoints = [];
        foreach ($table['endpoints'] as $entry) {
            $entry['patterns'] = array_map(self::pathSegments(...), $entry['paths']);
            $endpoints[] = $entry;
        }

        return ['endpoints' => $endpoints, 'methodDefault' => $table['methodDefault'], 'sqlReadWords' => self::set($table['sql']['readWords'])];
    }

    /**
     * Converts a command document or BSON value to a plain array, or null for a scalar BSON type
     * such as an ObjectId, which has no keys to search.
     *
     * @return array<int|string,mixed>|null
     */
    public static function asArray(mixed $value): ?array
    {
        return match (true) {
            is_array($value) => $value,
            $value instanceof \ArrayObject => $value->getArrayCopy(),
            $value instanceof \stdClass => (array) $value,
            // The driver's own document and array types, and anything serialisable to BSON.
            $value instanceof \MongoDB\BSON\Document, $value instanceof \MongoDB\BSON\PackedArray
                => $value->toPHP(['root' => 'array', 'document' => 'array', 'array' => 'array']),
            $value instanceof \MongoDB\BSON\Serializable => self::asArray($value->bsonSerialize()),
            default => null,
        };
    }

    /**
     * Whether any key of an aggregation pipeline, at any depth (sub-pipelines included), is in `$stages`.
     *
     * @param array<string,true> $stages
     */
    private static function pipelineUses(mixed $value, array $stages): bool
    {
        $items = self::asArray($value);
        if ($items === null) {
            return false;
        }
        foreach ($items as $key => $inner) {
            if (is_string($key) && isset($stages[$key])) {
                return true;
            }
            if (self::pipelineUses($inner, $stages)) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string,array<string,true>> */
    private static function loadRedis(): array
    {
        $table = Tables::redis();

        return [
            'read' => self::set([...$table['read'], ...$table['moduleRead']]),
            'session' => self::set($table['session']),
            'transaction' => self::set($table['transaction']),
        ];
    }

    /** @return array<string,mixed> */
    private static function loadMongo(): array
    {
        $table = Tables::mongodb();

        return [
            'read' => self::set($table['read'], true),
            'session' => self::set($table['session'], true),
            'notInTransaction' => self::set($table['notInTransaction']['commands'], true),
            'stages' => $table['notInTransaction']['stages'],
        ];
    }

    /** @return array<string,mixed> */
    private static function loadDynamo(): array
    {
        $table = Tables::dynamodb();

        return ['read' => self::set($table['read']), 'partiql' => self::set($table['partiql']['operations'])];
    }

    /**
     * @param list<string> $names
     * @return array<string,true>
     */
    private static function set(array $names, bool $lower = false): array
    {
        $set = [];
        foreach ($names as $name) {
            $set[$lower ? strtolower($name) : $name] = true;
        }

        return $set;
    }
}
