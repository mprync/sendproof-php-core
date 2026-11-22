<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores\Redis;

use Predis\Command\CommandInterface;
use Predis\Command\RawCommand;
use Predis\Connection\NodeConnectionInterface;
use Predis\Response\ErrorInterface;
use Sendproof\Core\Stores\CommandKind;
use Sendproof\Core\Stores\PreviewWriteBlockedException;

/**
 * Wraps a Predis node connection so every command is classified before any byte of it is written.
 *
 * The processor ({@see PredisGuardProcessor}) covers commands created through the client. This
 * decorator covers the rest: `executeRaw()`, commands built by hand, and pub/sub, none of which
 * pass through the factory. It also logs each command as a `Db` entry when it finishes, and keeps
 * a refused write from leaving the connection half-way through `MULTI` or a pipeline.
 *
 * @internal Installed by {@see PredisGuard::install()}
 */
final class GuardedPredisConnection implements NodeConnectionInterface
{
    /**
     * Read-only topology commands a cluster or replication connection sends on its nodes by itself
     * (Predis's `RedisCluster` asks `CLUSTER SLOTS`, Sentinel replication asks the sentinels). They
     * report where data lives and change nothing, so a node inside an aggregate lets them through.
     */
    private const TOPOLOGY = ['CLUSTER|SLOTS', 'SENTINEL|GET-MASTER-ADDR-BY-NAME', 'SENTINEL|SENTINELS', 'SENTINEL|REPLICAS', 'SENTINEL|SLAVES'];

    private bool $inMulti = false;

    /** @param bool $aggregateNode Whether the connection is a node of a cluster or replication connection */
    public function __construct(private readonly NodeConnectionInterface $inner, private readonly RedisHook $hook, private readonly bool $aggregateNode = false)
    {
    }

    public function connect()
    {
        $this->inner->connect();
    }

    public function disconnect()
    {
        $this->inMulti = false;
        $this->inner->disconnect();
    }

    public function isConnected()
    {
        return $this->inner->isConnected();
    }

    public function writeRequest(CommandInterface $command)
    {
        $kind = $this->check($command, true);
        // A pipeline reads its replies later, in a way this decorator can't pair with the command, so the
        // command is logged as it is written, without a duration.
        $this->hook->record($command->getId(), array_values($command->getArguments()), $kind, hrtime(true));
        $this->inner->writeRequest($command);
    }

    public function readResponse(CommandInterface $command)
    {
        return $this->inner->readResponse($command);
    }

    /**
     * A pipeline serialises every queued command into one buffer and writes it here, so this is the
     * last place to refuse one. The buffer is parsed and each command classified before a byte of it
     * is written; a buffer that can't be parsed is refused as a write, so the guard fails closed.
     */
    public function write(string $buffer): void
    {
        $commands = self::parseRequests($buffer, $this->hook->watching());
        $kinds = [];
        foreach ($commands ?? [['PIPELINE', []]] as [$name, $args]) {
            $kinds[] = $this->classify($name, $args, false);
        }
        foreach ($commands ?? [] as $index => [$name, $args]) {
            $this->hook->record($name, $args, $kinds[$index], hrtime(true));
        }
        $this->inner->write($buffer);
    }

    public function executeCommand(CommandInterface $command)
    {
        $kind = $this->check($command, false);
        $started = hrtime(true);
        try {
            $response = $this->inner->executeCommand($command);
        } catch (\Throwable $error) {
            $this->hook->record($command->getId(), array_values($command->getArguments()), $kind, $started, $error);
            throw $error;
        }
        $this->finish($command, $kind, $started, $response);

        return $response;
    }

    public function getParameters()
    {
        return $this->inner->getParameters();
    }

    public function __toString()
    {
        return (string) $this->inner;
    }

    public function getResource()
    {
        return $this->inner->getResource();
    }

    public function getClientId(): ?int
    {
        return $this->inner->getClientId();
    }

    public function addConnectCommand(CommandInterface $command)
    {
        $this->inner->addConnectCommand($command);
    }

    public function read()
    {
        return $this->inner->read();
    }

    public function hasDataToRead(): bool
    {
        return $this->inner->hasDataToRead();
    }

    public function getProtocol()
    {
        return $this->inner->getProtocol();
    }

    public function writeBuffer($buffer)
    {
        $this->inner->writeBuffer($buffer);
    }

    public function readBuffer($length)
    {
        return $this->inner->readBuffer($length);
    }

    public function readLine()
    {
        return $this->inner->readLine();
    }

    /** Anything else the wrapped connection offers (stream access, Relay methods) passes through. */
    public function __call(string $method, array $arguments): mixed
    {
        return $this->inner->{$method}(...$arguments);
    }

    /**
     * Classifies a command before it is written. A refused write discards a half-built `MULTI`, or
     * drops a connection whose pipeline is half-written, so no reply is left to mismatch.
     */
    private function check(CommandInterface $command, bool $pipelined): CommandKind
    {
        return $this->classify(strtoupper($command->getId()), array_values($command->getArguments()), $pipelined);
    }

    /** @param list<mixed> $args */
    private function classify(string $id, array $args, bool $pipelined): CommandKind
    {
        if ($this->aggregateNode && $args !== [] && is_string($args[0]) && in_array($id . '|' . strtoupper($args[0]), self::TOPOLOGY, true)) {
            return CommandKind::Session;
        }
        try {
            $kind = $this->hook->check($id, $args);
        } catch (PreviewWriteBlockedException $refusal) {
            try {
                if ($this->inMulti) {
                    $this->inMulti = false;
                    $this->inner->executeCommand(new RawCommand('DISCARD', []));
                } elseif ($pipelined) {
                    $this->inner->disconnect();
                }
            } catch (\Throwable) {
                // Nothing more can be done; the refusal is what the caller sees.
            }
            throw $refusal;
        }
        if ($kind === CommandKind::Transaction) {
            $this->inMulti = $id === 'MULTI' || ($this->inMulti && $id === 'WATCH');
        }

        return $kind;
    }

    private function finish(CommandInterface $command, CommandKind $kind, int $started, mixed $response): void
    {
        $error = $response instanceof ErrorInterface ? new \RuntimeException($response->getMessage()) : null;
        $this->hook->record($command->getId(), array_values($command->getArguments()), $kind, $started, $error);
    }

    /**
     * Splits a RESP request buffer (`*2\r\n$3\r\nGET\r\n$1\r\nk\r\n…`) into commands. Returns null
     * when the buffer is not a sequence of well-formed command arrays. Outside a Preview and an observed
     * Send nothing is refused or logged, so `$strict` false skips the work and returns an empty list.
     *
     * @return list<array{0:string,1:list<string>}>|null
     */
    private static function parseRequests(string $buffer, bool $strict = true): ?array
    {
        if (!$strict) {
            return [];
        }
        $commands = [];
        $offset = 0;
        $length = strlen($buffer);
        while ($offset < $length) {
            if ($buffer[$offset] !== '*' || ($end = strpos($buffer, "\r\n", $offset)) === false) {
                return null;
            }
            $count = (int) substr($buffer, $offset + 1, $end - $offset - 1);
            $offset = $end + 2;
            $parts = [];
            for ($index = 0; $index < $count; $index++) {
                if (($buffer[$offset] ?? '') !== '$' || ($end = strpos($buffer, "\r\n", $offset)) === false) {
                    return null;
                }
                $size = (int) substr($buffer, $offset + 1, $end - $offset - 1);
                $offset = $end + 2;
                if ($offset + $size + 2 > $length) {
                    return null;
                }
                $parts[] = substr($buffer, $offset, $size);
                $offset += $size + 2;
            }
            if ($parts === []) {
                return null;
            }
            $commands[] = [strtoupper(array_shift($parts)), $parts];
        }

        return $commands;
    }
}
