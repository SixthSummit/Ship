# ShipAPI v4 implementation status

- **Status:** operation architecture released; subsequent development and consumer adoption remain independently gated
- **Branches:** `dev` (development/snapshots), `main` (stable releases)
- **Decision:** v4 GA targets the operation kernel
- **Last architecture gate:** 2026-09-18 (M10 completion gate, SAPI-113)

## Completed

| Area | Evidence |
| --- | --- |
| Repository trust | pnpm workspace, Biome, focused architecture rules, reproducible package builds, trust-zone audit workflow |
| Kernel | Typed operations/modules/providers, deterministic graph, direct executor, stable diagnostics and errors |
| Access | Actor/identity split, permission policies, direct/HTTP enforcement, Firebase adapter |
| HTTP | Hono projection, stable wire errors, JSON/text/binary responses, bounded JSON/raw/multipart requests |
| Database | Executable read/write unit of work, nested rollback policy, explicit repositories/projections, tenant capabilities |
| Contracts | Browser-safe structural client, deterministic manifest fingerprint, codecs, OpenAPI 3.1 |
| Tooling | Graph check/inspect/affected, contract emission, exact legacy-route migration mapping |
| Scaffold | Focused CLI creates a minimal operation application with exact release-manifest pins and an independently executable verification gate |
| Packages | Core, Hono, Drizzle, contract, Firebase, OTel, testing, and CLI split into owned artifacts |
| Actor kinds, outbox, idempotency | ADR-0014: `human`/`system`/`provider` actors with kind-scoped access; durable transactional outbox (writer, dispatcher with lease/retry/dead-letter, cleanup with retention) on PostgreSQL and in-memory backends; executor-enforced operation idempotency; contract projection; customized golden consumer coverage |
| Streaming responses | Declared `stream`/SSE response mode with kernel diagnostics, adapter heartbeats/limits/cancellation, manifest and OpenAPI projection, browser-safe client stream handle, compat parity test, and a streaming operation in the customized golden consumer (ADR-0016, `docs/v4/streaming.md`) |
| Declared read cache | ADR-0019: per-operation `cache` on reads with framework-derived actor/tenant/public keys, `invalidates` recording durable purge intents in the write transaction and dispatched afterwards, `CacheBackend` with Redis and in-memory adapters passing one conformance suite, `x-ship-cache`/`Cache-Control` and contract/OpenAPI projection, graph tag edges, real-PostgreSQL commit-rollback-recovery coverage and a cached customized golden consumer read |
| Realtime publication | Kernel channels with actor/tenant/resource scopes, per-channel publication effects, graph/manifest projection, transport-neutral backend contract plus conformance suite, and a Socket.IO + Redis gateway adapter with multi-process delivery, presence, backpressure, and 500/s × 60 s evidence in ADR-0017; `transaction: "write"` operations publish through the framework-owned `ship-realtime.publication` outbox (`defineRealtimePublicationModule`) with eventual, at-least-once delivery proven against real PostgreSQL + Redis + Socket.IO and in the customized golden consumer (ADR-0017 addendum) |
| Inbound webhooks | ADR-0018: `defineWebhook` with bounded raw bytes, pure verifier contract with declared guarantees, provider actor only after verification, executor idempotency with in-flight policy, enqueue-mode durable receipt via the outbox with replay and retention; Hono canonical-URL verification and stable failure codes; Drizzle/in-memory event stores; contract exclusion and `x-ship-webhook` OpenAPI; OTel metrics; optional `@sixthsummit/ship-webhooks` verifiers (Stripe, GitHub, Slack, Twilio, Resend, HighLevel, shared-secret); live PostgreSQL two-process, load and crash tests; compat parity; customized golden consumer Stripe enqueue + Twilio inline coverage |
| Jobs and schedules | ADR-0015: `defineJob` with schedule/interval/enqueue/http triggers compiled as system-actor operations, per-key single-runner leases, backpressure, dead-letter management, retention cleanup and worker modes; BullMQ backend with Redis lock and OTel metrics, Drizzle advisory locks, in-memory backend plus conformance suite; two-process, crash/restart, cleanup and metrics integration evidence; scheduled and enqueued jobs in the customized golden consumer |
| Transactional mail | ADR-0023: `defineMailer` with typed messages and pure HTML + text templates declared on modules and projected into graph and contract (names only); `@sixthsummit/ship-mail` delivers every send as a `mail.deliver` job run with a typed sender, per-send idempotency key, ledger claim (one provider call per key across retries and replays), allowlist interceptor with `X-Ship-Original-To`, previews, log and Resend adapters and conformance suites; `ship_mail_sends` ledger in `ship-drizzle`; PostgreSQL integration evidence and the customized golden consumer `reports.email` path |
| Capacity baseline | SAPI-113 step 11: framework-owned, re-runnable combined load harness (`fixtures/capacity`, `pnpm test:capacity`, 60 s short mode for CI) that composes the customized golden consumer with the production adapters and runs jobs at declared concurrency across tenant keys, ADR-0017-rate realtime publishing across two gateway processes and signed webhook bursts concurrently against one disposable PostgreSQL and one Redis, sampling queue depth and lag, per-tenant fairness, `pg_stat_activity`/`pg_locks`, Redis memory, outbox backlog and realtime loss into a Markdown table and JSON; the 10-minute dev-SHA run and the knob that moves its first bottleneck are recorded in `docs/v4/capacity-baseline.md` (not a production capacity claim) |
| Schema safety | ADR-0021: `@sixthsummit/ship-schema-lint` migration linter enforcing the production column rules with recipes and justified allowlist, `pg_catalog` snapshot drift check, gated release preset refusing boot-time migration, boot guard, composite GitHub Action, per-rule fixtures, real-PostgreSQL hand-edit detection and the customized golden consumer wired end to end |
| Governance | RFC, 20 accepted ADRs, program changelog, commit/PR templates, release boundary |
| Public docs | Quick start, structure, HTTP, client, Angular, and mobile guides target the operation kernel; monolithic pages identify their compatibility status |

## Framework verification

The repository owns minimal and customized synthetic consumer applications,
packed contract/client fixtures, browser-safe boundary checks, real PostgreSQL
integration tests, and adapter conformance suites. Run the commands in the root
README against the exact candidate; older test totals are not current results.

Framework package versions and release membership are recorded by Changesets in
[package changelogs](../CHANGELOG.md). Application migrations, private route
catalogs, rollout status, and deployment receipts do not belong in this repository.

## Remaining boundaries

- Advanced form projection remains limited to the documented primitive subset.
- Compatibility APIs remain supported through their declared deprecation window.
- Each new adapter or capability requires executable conformance evidence.
- Package publication and application deployment are separate decisions.

See [public API guarantees](PUBLIC_API_SURFACE.md), [ADRs](rearchitecture/decisions/README.md),
and [release instructions](RELEASING.md).
