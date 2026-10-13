# Roadmap

The original architecture work is recorded in the phased
[`ShipAngular rearchitecture program`](architecture/REARCHITECTURE_PROGRAM.md). Its phase
records and checkpoint evidence are dated implementation history. Current release
intent lives in `.changeset/`; released changes live in the package changelog.

## Implemented

- structural operation contract/result/client types;
- typed Angular DI and sanitized request-scoped SSR context;
- operation-aware credential, CSRF, request-ID, idempotency, timeout, and retry policy;
- signal-tracked resources, mutations, ETag/304, cancellation, stale-result protection,
  and explicit optimistic rollback;
- temporary Hono v4 adapter;
- operation-backed session auth;
- explicit upload, signed upload, download, stream/SSE, socket, and form entrypoints;
- declared realtime publication client (`/realtime`, SAPI-109) — done: manifest-typed
  channels, presence, reconnect/resubscribe, SSR no-op; evidence is the Socket.IO gateway
  case in `pnpm test:browser-conformance` and ADR 0005;
- manifest-typed streaming response mode (`response.mode: "stream"`, SSE framing) on
  `createStream()` — see [ADR 0004](architecture/decisions/0004-streaming-response-mode.md)
  and the [streaming operations guide](guides/STREAMING_OPERATIONS.md); evidence: browser
  conformance serves the wire contract verbatim and asserts frames, terminal, `seq`,
  `connecting → open → closed`, both error branches, and abort;
- app-owned feature schematics;
- strict pnpm workspace, Turbo task graph, Biome/import checks, Vitest coverage, Knip,
  packed-package proof, Changesets, and commit/PR templates.

## Ongoing validation and adoption

- Run packed, browser, query, and real ShipAPI joint conformance for each candidate.
- Verify clean release artifacts against supported runtime versions.
- Approve application migrations and production rollout independently, with smoke,
  telemetry, and rollback evidence.
- Keep advanced generated bindings and compatibility removal subject to explicit
  decisions; implemented transport support alone does not complete every generator.

The optional `/query` entrypoint provides TanStack Query integration, including
read keys/scopes, mutations, infinite reads, and SSR hydration. See the
[query guide](guides/TANSTACK_QUERY.md) and retained `docs/evidence/query-*` records.

## Permanent boundaries

- ShipAngular remains frontend-only.
- ShipAPI owns operation declarations, server adapters, serialization, and generation.
- Third-party REST remains independent.
- Browser code never imports server/Hono/Drizzle/provider-admin/database runtime packages.
- Hono and legacy-REST compatibility are not extended for new work and are removed only
  after migration gates.

Ideas not tied to these architecture/reliability gates should wait until the backbone and
client migrations are proven.
