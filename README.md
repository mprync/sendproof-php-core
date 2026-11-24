# sendproof/core

Framework-neutral PHP core of [Sendproof protocol v1](https://github.com/mprync/sendproof/blob/a95579be596e1038c78584d274904a645f72e35a/spec/README.md). A framework integration such as [`sendproof/laravel`](https://github.com/mprync/sendproof/blob/a95579be596e1038c78584d274904a645f72e35a/adapters/php/laravel/README.md) supplies request dispatch and a database provider; this package supplies everything else.

| Area | Classes |
| --- | --- |
| Protocol rules | `Protocol` (Prefer parsing, same-origin check, preview target validation), `Capabilities` |
| Preview | `PreviewRunner` runs one operation in a rollback-only session and builds the confirmed envelope; `ObservedRunner` stores a trace for an ordinary send |
| Capture | `Recorder` (logs, effects, SQL, timing), `SqlRedactor`, `Limits` |
| Data layer contract | `PreviewProvider`, `PreviewSession`, `PreviewObservation` |
| Traces | `TraceStore`, `FileTraceStore` (TTL, per-owner and total caps), `TraceOwner` |
| Workbench UI | `UiBundle` reads the embedded bundle and verifies each file's SHA-256 against `manifest.json` |

## Embedded UI

The workbench UI is not copied into this repository's PHP sources. `resources/ui` is generated output of the shared packer and must be refreshed before a release:

```sh
composer embed-ui   # node tools/pack-ui.mjs --version 0.1.0-alpha.3 --out resources/ui
```

`UiBundle` serves only files listed in `manifest.json` and refuses any file whose hash does not match.

## Writing another framework adapter

1. Rewrite `/sendproof/_preview/<target>` to `<target>` and dispatch it through the framework's normal pipeline in the same process. Check `Protocol::hasExactPreference`, `Protocol::isValidTarget` and `Protocol::isSameOrigin` first.
2. Confirm the target was opted in before dispatching, so unmarked handlers never run.
3. Wrap the dispatch in `PreviewRunner::run`. Mark `PreviewState::reached` and `completed` from a marker that runs immediately around the handler, after authentication.
4. Convert the inner response to a `CapturedResponse`, including any unhandled error the framework turned into a response.
5. For Observed Send, use `ObservedRunner` with a `TraceStore` and an owner key from `TraceOwner::key`.

Implement `PreviewProvider` for your data layer: begin on the connection the handler uses, return a session that reports changes and verifies rollback, and release everything on every failure path.

## Tests

```sh
composer install && vendor/bin/phpunit
```

## Data stores

`Sendproof\Core\Stores` holds the write guard, the classifiers and the hooks for Predis, the AWS SDK and the MongoDB library. `PreviewRunner::run()` takes the hooked stores as its last argument. See [data stores in the PHP binding](https://github.com/mprync/sendproof/blob/a95579be596e1038c78584d274904a645f72e35a/adapters/php/data-stores.md).
