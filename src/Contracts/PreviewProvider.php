<?php

declare(strict_types=1);

namespace Sendproof\Core\Contracts;

/**
 * Connects the preview protocol to a data layer.
 *
 * A provider must enroll the whole operation in a transaction before the handler runs, report
 * what the handler changed, and roll the transaction back. Register one provider per application.
 */
interface PreviewProvider
{
    /** Whether the provider can currently enroll requests. */
    public function isAvailable(): bool;

    /** A display label for the database. It never contains credentials or host secrets. */
    public function database(): ?string;

    /**
     * Starts a rollback-only session on the connections the handler will use.
     * Implementations release any partially acquired resource if this throws.
     *
     * @throws \Throwable when the session cannot begin
     */
    public function begin(mixed $context): PreviewSession;

    /** Starts watching an ordinary send without altering it, or returns null when unsupported. */
    public function beginObservation(mixed $context): ?PreviewObservation;
}
