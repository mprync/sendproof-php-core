<?php

declare(strict_types=1);

namespace Sendproof\Core\Contracts;

/** A transaction that is never committed. Changes accumulate until it is rolled back. */
interface PreviewSession extends PreviewObservation
{
    /**
     * Rolls everything back and verifies that nothing was promoted.
     *
     * @throws \Throwable when rollback cannot be confirmed; the preview is then withheld
     */
    public function rollback(): void;
}
