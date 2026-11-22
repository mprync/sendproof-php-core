<?php

declare(strict_types=1);

namespace Sendproof\Core\Stores;

use Sendproof\Core\Capture\Recorder;

/**
 * One hooked data store, as the Preview runner and discovery see it.
 *
 * A `guard` store only describes itself: its hook refuses writes inside the client. A `preview`
 * store (MongoDB on a replica set) also starts a transaction before the handler runs and aborts
 * it in {@see finish()}, after reading what changed.
 */
interface DataStore
{
    /** The store id: `mongodb`, `redis` or `dynamodb`. */
    public function system(): string;

    /**
     * The discovery entry: `system`, an optional display `name`, `mode` (`preview` or `guard`) and,
     * for a guarded store that could have previewed, a `reason`.
     *
     * @return array{system:string,name?:string,mode:string,reason?:string}
     */
    public function describe(): array;

    /** Prepares a Preview before the handler runs, for example by starting a transaction. */
    public function begin(Recorder $recorder): void;

    /**
     * Ends a Preview after the handler: captures changes and aborts transactions. Throws when the
     * store cannot confirm that nothing was kept, which answers 500 without confirmation.
     */
    public function finish(Recorder $recorder): void;
}
