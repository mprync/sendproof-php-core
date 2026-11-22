<?php

declare(strict_types=1);

namespace Sendproof\Core\Ui;

/**
 * Reads the shared workbench UI bundle embedded in a package.
 *
 * The bundle is produced by `tools/pack-ui.mjs` and is never edited here. Only files listed in
 * `manifest.json` are served, and each file's SHA-256 is verified against the manifest, so a
 * tampered or partial install fails closed instead of serving unexpected content.
 */
final class UiBundle
{
    /** @var array{version:string,bundleHash:string,files:array<string,array{sha256:string,bytes:int,contentType:string}>}|null */
    private ?array $manifest = null;
    private bool $loaded = false;

    public function __construct(private readonly string $root)
    {
    }

    /** The bundle embedded in this package under `resources/ui`. */
    public static function embedded(): self
    {
        return new self(dirname(__DIR__, 2) . '/resources/ui');
    }

    /** Whether a readable manifest with an index page exists. */
    public function isAvailable(): bool
    {
        return isset($this->manifest()['files']['index.html']);
    }

    public function version(): ?string
    {
        return $this->manifest()['version'] ?? null;
    }

    public function bundleHash(): ?string
    {
        return $this->manifest()['bundleHash'] ?? null;
    }

    /**
     * Resolves a request path to a verified asset, or null when it is unknown or fails verification.
     */
    public function asset(string $path): ?UiAsset
    {
        $path = $path === '' ? 'index.html' : $path;
        $entry = $this->manifest()['files'][$path] ?? null;
        if ($entry === null || str_contains($path, '..') || str_contains($path, '\\')) {
            return null;
        }

        $file = $this->absolute($path);
        if (!is_file($file) || !hash_equals($entry['sha256'], (string) hash_file('sha256', $file))) {
            return null;
        }

        return new UiAsset($file, $entry['contentType'], $entry['bytes']);
    }

    private function absolute(string $path): string
    {
        return $this->root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $path);
    }

    /** @return array{version?:string,bundleHash?:string,files?:array<string,array{sha256:string,bytes:int,contentType:string}>} */
    private function manifest(): array
    {
        if (!$this->loaded) {
            $this->loaded = true;
            $json = @file_get_contents($this->root . DIRECTORY_SEPARATOR . 'manifest.json');
            $decoded = $json === false ? null : json_decode($json, true);
            $this->manifest = is_array($decoded) && isset($decoded['version'], $decoded['bundleHash'], $decoded['files']) && is_array($decoded['files'])
                ? $decoded
                : null;
        }

        return $this->manifest ?? [];
    }
}
