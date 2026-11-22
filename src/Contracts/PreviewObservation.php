<?php

declare(strict_types=1);

namespace Sendproof\Core\Contracts;

/** Reports row changes made while a request ran, and releases listeners on disposal. */
interface PreviewObservation
{
    /**
     * @return list<array{operation:string,table:string,key:mixed,before:?array,after:?array}>
     */
    public function changes(): array;

    public function changesTruncated(): bool;

    /** Releases listeners and connections. Must be safe to call more than once. */
    public function dispose(): void;
}
