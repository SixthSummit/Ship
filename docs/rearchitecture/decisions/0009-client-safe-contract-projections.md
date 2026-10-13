# ADR-0009: Project a client-safe contract from operations

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** Client manifest, OpenAPI, typed HTTP calls, codecs, and browser boundary
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md) · [ADR-0003](./0003-operation-results-and-errors.md) · [ADR-0005](./0005-http-wire-and-representation-contract.md)

## Context

The current v4 client exports Hono's `hc()` and parameterizes it with `typeof` the composed server application. That approach couples frontend types to route nesting and Hono internals, can exceed TypeScript's instantiation depth as applications grow, provides no portable runtime manifest or OpenAPI document, and encourages frontend packages to resolve server declarations.

The redesign already makes operations the authoritative declaration for input/output schemas, successful statuses, application errors, access, transaction behavior, dependencies, and transport bindings. Client artifacts must be projections of that declaration rather than a second handwritten contract.

## Decision

Every compiled application can project one immutable JSON client manifest containing:

- a schema version, application ID, and deterministic SHA-256 fingerprint;
- stable operation IDs;
- client-safe input, success, and declared-error schemas;
- access and transaction metadata;
- transport binding and representation metadata.

The projection excludes handlers and provider implementations. Zod 4 schemas project through its JSON Schema support. A non-Zod schema or non-JSON domain value must use `contractSchema()` with explicit JSON Schema and an optional named client codec. Projection fails with a stable, located diagnostic when fidelity cannot be established.

OpenAPI 3.1 is generated from the same manifest and carries the same fingerprint. `ship-api contract` emits both artifacts deterministically.

The default HTTP client implements a structural `OperationClient<TContract>` keyed by stable operation ID. `OperationTypeContract` is independent of Hono, and `ApplicationContractOf<typeof app>` is only a backend/co-located convenience. A separately published application contract may satisfy the structural type without resolving server runtime declarations.

Declared application and framework failures return as discriminated values. Network, cancellation, configuration, codec, and protocol failures throw. Every response must carry `X-Request-Id`; the client preserves status, response metadata, details, and unknown additive error fields. Framework error codes are reserved against application declarations.

The browser-safe `@sixthsummit/ship-api/contract` entry exports only the default client runtime plus neutral manifest/client types. The backend-only `ApplicationContractOf<TApp>` helper, Node hashing, OpenAPI, and Zod schema projection are separate subpaths. The package-split phase will turn those logical boundaries into independently audited artifacts.

Query arrays use an explicit bracket dialect so singleton and empty arrays do not collapse into scalar or missing values. `name[]=one` is a singleton, `name[]` is empty, and `name[]=` contains one empty string. Existing repeated query keys remain accepted for compatibility; mixing forms is rejected. OpenAPI parameters carry `x-ship-array-encoding: brackets` until a standard encoding can express all three cases without ambiguity.

## Consequences

- Hono route shape is no longer the target frontend contract.
- A URL or module-layout refactor need not rename a frontend call site when the operation ID and wire contract remain stable.
- Contract/OpenAPI drift is diffable in CI and attributable to one operation.
- Unsupported schema behavior fails at generation time instead of degrading to `any` or producing a client that lies.
- Browser code need not load Hono, Zod, Node crypto, databases, auth-provider SDKs, or observability libraries.
- Explicit codecs add configuration for non-JSON domain values, but keep wire conversion visible and testable.
- Bracket query encoding is a Ship extension that third-party generators need to honor; the vendor extension makes that limitation visible.
- The existing `hc()` entry remains a migration adapter until current v4 consumers move and a deprecation window is accepted.

## Rejected alternatives

### Keep `hc<typeof app>()` as the permanent contract

Rejected because it makes server framework internals part of the frontend architecture and reproduces the scaling and packaging failures already observed.

### Hand-maintain DTOs, OpenAPI, or a frontend client

Rejected because duplicated declarations drift and require human or prompt compliance rather than executable derivation.

### Guess serialization for dates and other domain values

Rejected because runtime validation, JSON Schema, and frontend values can disagree silently. Unsupported projection must fail until the operation supplies explicit metadata.

### Throw every non-2xx response

Rejected because expected domain failures are part of the operation contract. Only failures outside that declared protocol remain exceptional.
