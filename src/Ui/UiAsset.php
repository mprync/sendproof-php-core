<?php

declare(strict_types=1);

namespace Sendproof\Core\Ui;

/** A verified file from the embedded workbench bundle. */
final class UiAsset
{
    public function __construct(
        public readonly string $path,
        public readonly string $contentType,
        public readonly int $bytes,
    ) {
    }
}
