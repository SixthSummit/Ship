# Framework overview

ShipAngular is frontend-only Angular platform infrastructure. ShipAPI is its separate
backend counterpart. Their integration is a generated client-safe operation contract, not
a shared server source tree.

## Layers

```text
application components and app-owned features
                ↓
Angular resources, mutations, forms, auth, and capability state
                ↓
structural OperationClient + shared request policy
                ↓
ShipAPI generated browser client and transport adapters
```

ShipAPI owns operation declarations, stable IDs, schemas/codecs, serialization, errors,
and transport metadata. ShipAngular owns dependency injection, signals, browser lifecycle,
SSR request scope, and presentation adaptation.

## Angular conventions

- standalone OnPush components;
- signal-first public APIs;
- `inject()` DI;
- functional guards/interceptors;
- new control flow and typed reactive forms;
- browser/SSR separation with no request state in singletons.

These are checked by TypeScript, the Angular compiler, ESLint rules, tests, and generated
application gates.

## Data boundaries

ShipAPI operations use `/operations`, the import-free `/ship-api` adapter, and a packed
browser-safe contract. Declared failures are values; network, abort, timeout, and protocol
failures are exceptions. Uploads, downloads, streams, and sockets use explicit entrypoints
and common policy preparation.

Third-party REST uses Angular `HttpClient` or the generic root `ApiClient`/`createResource`
surface. It does not receive ShipAPI credentials, codecs, or retries accidentally.

Pinned v4 sites may use `/hono-v4`; the app owns the route-tree mapping and migrates each
behavior to a stable operation ID. The target interface is not weakened to resemble Hono.

## Auth and SSR

Frontend `AuthAdapter` state remains signal-based. Transport credentials are separate
capabilities so current bearer tokens, cookie mode, CSRF, and one explicitly allowed
refresh are resolved per attempt.

`provideShipOperationBoundary` creates one client/request-policy pair from a sanitized
`ShipClientContext`. On SSR the context contains only allowlisted cookies/headers and the
incoming abort signal. It never exposes the raw request or browser globals. The narrower
`provideShipClient` remains available when a client does not need non-JSON capabilities.

## Features and packaging

Reusable behavior must be a compiled secondary entrypoint with public API, tests, bundle
budget, dependency analysis, and packed-consumer proof. Product-specific UI is generated
into `src/app/modules` and owned by the application. The old source-copy catalog is gone.

The repo uses pnpm workspaces, a measured Turbo graph, Biome for TypeScript formatting and
imports, ESLint/Angular compiler for semantic rules, Vitest with 80% minimum coverage,
Knip, Changesets, and deterministic tarball conformance.

See the [operation guide](OPERATION_CLIENT_GUIDE.md), [entrypoint reference](../api/LIBRARY_EXPORTS.md),
[testing gates](TESTING_GATES.md), and [program dashboard](REARCHITECTURE_PROGRAM.md).
