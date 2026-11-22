<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

/** How the guard treats one store command. Only `Write` can block a Preview. */
enum CommandKind: string
{
    case Read = 'read';
    case Write = 'write';
    /** A connection-level command such as `AUTH`, `HELLO` or `SELECT`: allowed and never logged. */
    case Session = 'session';
    /** `MULTI`, `EXEC`, `DISCARD`, `WATCH` and `UNWATCH`: allowed, with each queued command classified on its own. */
    case Transaction = 'transaction';
}
