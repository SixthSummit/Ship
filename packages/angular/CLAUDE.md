# packages/core — library guidance

Read `/AGENTS.md` first. This package publishes `@sixthsummit/ship-angular`, its secondary
entrypoints, CLI, schematics, and starter template.

## Public boundaries

The root `src/public-api.ts` is the legacy/general Angular surface. Independent secondary
entrypoints are defined by their own `ng-package.json` and `src/public-api.ts` files:

- `/operations` — structural operation client, DI, result/error types, unary resources;
- `/ship-api` — import-free adapter for ShipAPI's structural browser client and manifest;
- `/auth` — operation credential and SSR request-context capabilities;
- `/firebase-auth` — optional Firebase `AuthAdapter` implementation;
- `/download`, `/upload`, `/stream`, `/socket` — explicit non-JSON transports;
- `/realtime` — declared realtime publication typed from the manifest's `channels`; `socket.io-client`
  is an optional peer of this entry only and is imported lazily;
- `/forms` — browser-safe schema bindings;
- `/testing` — runner-independent conformance helpers;
- `/hono-v4` — temporary compatibility only.
- `/legacy-rest` — temporary pre-Hono URL-client migration only.

Do not make a new ShipAPI feature depend on the root Hono/resource wrappers. A public
contract change requires implementation tests, type tests, docs, and a changeset.

## Hard rules

1. Never hand-edit `src/version.ts`; run `pnpm sync-version` at the repository root.
2. Use `import type` under `verbatimModuleSyntax`.
3. Keep browser entrypoints free of server, Hono, Drizzle, Node, provider-admin, database,
   and server-observability runtime dependencies.
4. Keep declared application errors as discriminated values. Network, abort, protocol,
   malformed-response, and programmer failures remain exceptions.
5. Never log credentials, cookies, raw provider errors, or unredacted validation values.
6. Each operation call propagates its `AbortSignal`; SSR state is request-scoped.
7. Capability-specific transports are not forced through the JSON unary contract.

## Build and verification

`pnpm build` runs ng-packagr, compiles schematics, and copies only CLI, schematics, and
the default template into `lib/`. It does not copy repository-root feature catalogs.

Use:

```bash
pnpm type-check
pnpm test
pnpm test:coverage
pnpm build
pnpm test:packed-conformance
pnpm test:browser-conformance
pnpm measure-bundle:enforce
pnpm knip
```

`pnpm test:packed-conformance` packs isolated synthetic client-safe fixtures and proves
the npm boundary offline. `pnpm test:browser-conformance` packs the current build and
proves upload, download, stream, socket, CORS, credential-policy, and cancellation behavior
in Chromium against a deterministic local fixture. `pnpm test:joint-conformance -- --manifest
<path>` is reserved for real packed ShipAPI artifacts and intentionally fails when they are
absent.

Tests are colocated `*.test.ts` files. The global coverage gate is at least 80 percent in
all metrics. Type-only contracts also use the configured positive and negative TypeScript
programs.

## Auth and resources

When changing `AuthAdapter` or auth services, update the conformance suite and every
built-in adapter together. Bearer credentials must be read at call time; SSR may forward
only configured cookies and headers.

When changing operation resources, prove dependency tracking, reload, abort, stale-result
suppression, declared failures, and presentation-error conversion. The overloaded root
`createResource` remains for third-party REST and pinned clients but should not gain new
ShipAPI responsibilities.

## Schematics and template

The API-client schematic generates an app-owned structural provider and imports only a
client-safe contract type. Module/page schematics write into `src/app/modules` so output
is compiled, linted, tested, and owned by the application.

The default template is a real shipped consumer. Keep pnpm commands, Angular versions,
placeholders, SSR safety, CI, and documentation aligned. Smoke it through the CLI without
network, then install/build it in the packed-consumer proof where appropriate.
