<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Redis;

use Sendproof\Core\Stores\Classifier;
use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\Guard;

/**
 * What every Redis client hook shares: classify a command and let the guard refuse it before it is
 * sent, then log it as a `Db` entry whose statement keeps the command name and key arguments only.
 *
 * Predis ({@see PredisGuard}) and phpredis (the Laravel connection) call {@see check()} before a
 * command is written and {@see record()} when it finishes. Session commands such as `AUTH`,
 * `HELLO` and `SELECT` are never guarded or logged, so the password never reaches a capture.
 */
final class RedisHook
{
    /**
     * Commands whose key arguments are known, as a rule over the argument list. Anything not listed
     * shows no key: an unknown command's arguments are all treated as values.
     */
    private const KEYS = [
        // The first argument is the only key.
        'first' => [
            'APPEND', 'BITCOUNT', 'BITFIELD', 'BITFIELD_RO', 'BITPOS', 'DECR', 'DECRBY', 'DUMP', 'EXPIRE', 'EXPIREAT', 'EXPIRETIME', 'GEOADD',
            'GEODIST', 'GEOHASH', 'GEOPOS', 'GEORADIUS', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER', 'GEORADIUSBYMEMBER_RO', 'GEOSEARCH', 'GET',
            'GETBIT', 'GETDEL', 'GETEX', 'GETRANGE', 'GETSET', 'HDEL', 'HEXISTS', 'HEXPIRE', 'HGET', 'HGETALL', 'HINCRBY', 'HINCRBYFLOAT',
            'HKEYS', 'HLEN', 'HMGET', 'HMSET', 'HRANDFIELD', 'HSCAN', 'HSET', 'HSETNX', 'HSTRLEN', 'HTTL', 'HVALS', 'INCR', 'INCRBY',
            'INCRBYFLOAT', 'LINDEX', 'LINSERT', 'LLEN', 'LPOP', 'LPOS', 'LPUSH', 'LPUSHX', 'LRANGE', 'LREM', 'LSET', 'LTRIM', 'PERSIST',
            'PEXPIRE', 'PEXPIREAT', 'PEXPIRETIME', 'PFADD', 'PSETEX', 'PTTL', 'RPOP', 'RPUSH', 'RPUSHX', 'SADD', 'SCARD', 'SET', 'SETBIT',
            'SETEX', 'SETNX', 'SETRANGE', 'SISMEMBER', 'SMEMBERS', 'SMISMEMBER', 'SPOP', 'SRANDMEMBER', 'SREM', 'SSCAN', 'STRLEN', 'SUBSTR',
            'TTL', 'TYPE', 'XACK', 'XADD', 'XAUTOCLAIM', 'XCLAIM', 'XDEL', 'XLEN', 'XPENDING', 'XRANGE', 'XREVRANGE', 'XTRIM', 'ZADD',
            'ZCARD', 'ZCOUNT', 'ZINCRBY', 'ZLEXCOUNT', 'ZMSCORE', 'ZPOPMAX', 'ZPOPMIN', 'ZRANDMEMBER', 'ZRANGE', 'ZRANGEBYLEX',
            'ZRANGEBYSCORE', 'ZRANK', 'ZREM', 'ZREMRANGEBYLEX', 'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYLEX',
            'ZREVRANGEBYSCORE', 'ZREVRANK', 'ZSCAN', 'ZSCORE', 'JSON.GET', 'JSON.SET', 'JSON.DEL', 'JSON.MGET', 'SORT', 'SORT_RO',
            'RESTORE',
        ],
        // Every argument is a key.
        'all' => ['DEL', 'EXISTS', 'MGET', 'PFCOUNT', 'PFMERGE', 'SDIFF', 'SDIFFSTORE', 'SINTER', 'SINTERSTORE', 'SUNION', 'SUNIONSTORE', 'TOUCH', 'UNLINK', 'WATCH'],
        // The first two arguments are keys.
        'two' => ['COPY', 'LMOVE', 'BLMOVE', 'RENAME', 'RENAMENX', 'RPOPLPUSH', 'BRPOPLPUSH', 'SMOVE'],
        // Every second argument, from the first, is a key.
        'alternate' => ['MSET', 'MSETNX'],
        // Every argument but the last is a key (a timeout follows).
        'blocking' => ['BLPOP', 'BRPOP', 'BZPOPMAX', 'BZPOPMIN'],
    ];

    /** @var array<string,string>|null command => rule */
    private static ?array $rules = null;

    /**
     * @param array<string,true>|null $reads host-declared reads, upper-case names
     * @param string|null $namespace The Redis database number, for `db.namespace`
     */
    public function __construct(
        private readonly Guard $guard,
        private readonly ?array $reads = null,
        private readonly ?string $namespace = null,
    ) {
    }

    /** Whether the current request is a Preview or an observed Send, so commands must be looked at. */
    public function watching(): bool
    {
        return $this->guard->inPreview() || $this->guard->recorder()->isCapturing();
    }

    /**
     * Classifies a command and lets the guard refuse a write before anything is sent.
     *
     * @param list<mixed> $args
     * @throws \Sendproof\Core\Stores\PreviewWriteBlockedException
     */
    public function check(string $name, array $args): CommandKind
    {
        $kind = Classifier::redis($name, $args, $this->reads);
        $this->guard->guard('redis', strtoupper($name), $kind);

        return $kind;
    }

    /**
     * Logs a finished command on the current request's recorder (a Preview or an observed Send).
     * Session and transaction-control commands are skipped.
     *
     * @param list<mixed> $args
     */
    public function record(string $name, array $args, CommandKind $kind, int $startedNs, ?\Throwable $error = null): void
    {
        if ($kind === CommandKind::Session || $kind === CommandKind::Transaction) {
            return;
        }
        $recorder = $this->guard->recorder();
        if (!$recorder->isCapturing()) {
            return;
        }
        ['statement' => $statement, 'target' => $target] = self::describe($name, $args);
        $code = null;
        if ($error !== null) {
            $code = explode(' ', trim($error->getMessage()), 2)[0];
            $code = $code === '' ? (new \ReflectionClass($error))->getShortName() : $code;
        }
        $recorder->db([
            'system' => 'redis',
            'operation' => strtoupper($name),
            'statement' => $statement,
            'target' => $target,
            'namespace' => $this->namespace,
            'error' => $code,
            'elapsedMs' => (hrtime(true) - $startedNs) / 1e6,
        ]);
    }

    /**
     * The `Db` statement and target of a command: the name, then each key argument as written and
     * every other argument as `?` (`SET session:42 ?`). Values never appear.
     *
     * @param list<mixed> $args
     * @return array{statement:string,target:?string}
     */
    public static function describe(string $name, array $args): array
    {
        $operation = strtoupper($name);
        $keys = self::keyIndexes($operation, $args);
        $shown = array_flip($keys);
        $parts = [$operation];
        foreach ($args as $index => $arg) {
            $parts[] = isset($shown[$index]) ? self::text($arg) : '?';
        }

        return ['statement' => implode(' ', $parts), 'target' => $keys === [] ? null : self::text($args[$keys[0]])];
    }

    /**
     * Positions of the key arguments of a command.
     *
     * @param list<mixed> $args
     * @return list<int>
     */
    private static function keyIndexes(string $operation, array $args): array
    {
        self::$rules ??= (static function (): array {
            $rules = [];
            foreach (self::KEYS as $rule => $names) {
                foreach ($names as $name) {
                    $rules[$name] = $rule;
                }
            }

            return $rules;
        })();
        $count = count($args);

        // Container commands keep their key after the subcommand, as in OBJECT ENCODING key.
        if (in_array($operation, ['OBJECT', 'MEMORY', 'XINFO'], true) && $count > 1) {
            return [1];
        }
        // Scripts name their keys by count: EVAL script numkeys key… arg…
        if (in_array($operation, ['EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO', 'FCALL', 'FCALL_RO'], true) && $count > 1) {
            return range(2, min($count - 1, 1 + max(0, (int) $args[1])));
        }
        if (in_array($operation, ['ZUNIONSTORE', 'ZINTERSTORE', 'ZDIFFSTORE'], true) && $count > 1) {
            return [0, ...range(2, min($count - 1, 1 + max(0, (int) $args[1])))];
        }
        if (in_array($operation, ['ZUNION', 'ZINTER', 'ZDIFF'], true) && $count > 0) {
            return range(1, min($count - 1, max(0, (int) $args[0])));
        }

        return match (self::$rules[$operation] ?? null) {
            'first' => $count > 0 ? [0] : [],
            'all' => $count > 0 ? range(0, $count - 1) : [],
            'two' => $count > 1 ? [0, 1] : ($count > 0 ? [0] : []),
            'alternate' => $count > 0 ? range(0, $count - 1, 2) : [],
            'blocking' => $count > 1 ? range(0, $count - 2) : [],
            default => [],
        };
    }

    private static function text(mixed $value): string
    {
        return is_scalar($value) || $value instanceof \Stringable ? (string) $value : '?';
    }
}
