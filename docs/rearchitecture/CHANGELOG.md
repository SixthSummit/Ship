# ShipAPI rearchitecture changelog

This changelog records decisions, prototypes, implementation milestones, measurements, and reversals for the agent-native ShipAPI redesign.

It does not replace package changelogs or Changesets. Consumer-visible package changes continue to use the repository release process.

Entries describe completed work only. Future work belongs in the RFC, an ADR, or an issue—not in this changelog.

## Development milestones

These entries span released and pending development work. The package changelogs
and queued Changesets are authoritative for release membership; the historical
heading did not mean that every item below was still unreleased.

### Added

- Accepted [ADR-0025](./decisions/0025-first-party-credential-auth.md): first-party credential authentication (SAPI-755). The new `@sixthsummit/ship-auth-credentials` package composes `defineCredentialAuthModule({ store, mailer, mail, links, secrets, policies })`: register, email verification, sign-in with lockout, sessions with revoke and revoke-all (plus the account-level `sessionsInvalidBefore` cutoff), password reset, change-email, TOTP enrolment, challenge and recovery codes as declared operations under `/auth/*`, every outcome audited without secrets. `credentialAuthentication()` is an actor provider beside the Firebase resolver with the same actor contract; `credentialAuthRateLimitPolicies()` rides the SAPI-476 pre-validation hook; mail goes through `defineMailer`/`defineMailDelivery`; policies (password, lockout, session, `mfa.required` per role, token TTLs) are configuration. `shipAuthTables()`/`createDrizzleCredentialStore()` own the seven tables through the gated migration path with conditional once-only writes, proven by `credentialStoreConformance` in memory and on PostgreSQL; `credentialAuthConsoleExtension()` lands the auth-audit panel through the console's extension seam; `@sixthsummit/ship-angular/credential-auth` ships the sign-in, MFA challenge, recovery-code and audit-panel screens over the structural client. Security choices (scrypt, RFC 6238 TOTP with replay guard, SHA-256 token hashes, AES-256-GCM MFA secrets under a key ring, constant-time comparisons, opaque hashed bearers) are tabled in the ADR for review. The customized golden consumer runs it beside its session directory with migration `0004_credential_auth`; held at proof stage per the two-consumer rule (Tortlink v2 named, second consumer pending). See [docs/v4/features/auth-credentials.md](../v4/features/auth-credentials.md).
- Added `createHonoAdapter({ cors })` to `@sixthsummit/ship-hono` (SAPI-760): the compat tier's `CorsOptions` shape with the same wildcard-plus-credentials guard (security finding F4), applied to operation, streaming and webhook routes and their preflights, exposing `X-Request-Id`, `X-Ship-Cache` and declared error headers by default, refusing `http.options` operations alongside the policy, and reserving `Access-Control-*` on `respond()`. The `ship-api create` scaffold wires it from `CORS_ORIGINS` in `src/http.ts`; both golden consumers exercise preflight, credentialed simple requests and the guard. Named consumers: the Ship project template (its `apps/api/src/http.ts` workaround can go) and Acclivity/Axis parity with compat CORS.
- Promoted shared runtimes to peer dependencies (SAPI-761): `hono` in `ship-hono`, `drizzle-orm` in `ship-drizzle` and `ship-testing`, `ioredis` in `ship-jobs-bullmq` and `ship-realtime-socketio`; `socket.io`, `bullmq` and the structural Redis client stay as they are. The rule is in `docs/VERSIONING.md`. The scaffold release manifest writes `hono` as ship-hono's caret peer range next to exact Ship pins, the golden consumers pin the same way, and `test:pack` plus the golden-consumer runner fail when a clean install resolves more than one `hono` or `drizzle-orm`.
- Accepted [ADR-0024](./decisions/0024-kernel-ops-console.md): the kernel ops console (SAPI-757). `@sixthsummit/ship-core` adds optional operator introspection to the adapter contracts — `JobBackend.introspection` (`declarations`, `listRuns`, `getRun`, `listSchedules`, `listPaused`, optional `pause`/`resume`), `WebhookEventStore.list`, `OutboxBackend.findRecord`/`listRecords` and `RealtimePublishBackend.introspection.channels` — implemented by the in-memory adapters, the BullMQ backend, the PostgreSQL backend (durable pause through the opt-in `shipJobControlTable()`) and the Socket.IO gateway. The new `@sixthsummit/ship-console` package composes `defineConsoleModule({ jobs, outboxes, webhooks, realtime, extensions })`: jobs (depth, running, failed, dead-letter, run detail, retry, discard, bulk retry, pause/resume), cron (schedules with next and last run, trigger-now), webhooks (receipts by endpoint with the spawned outbox record, recent outcomes through `createConsoleWebhookObserver`, detail, replay), realtime (channels with subscriber counts and last publish) and outbox (pending/leased/dead-lettered inspection, retry, discard), every one a declared operation under `/console/*` gated by the dedicated `console.operate` slug that no management permission implies, plus an extension seam for the auth-audit panel. `@sixthsummit/ship-angular/console` ships `provideShipConsole`, the signal-first `ShipConsole`, the panel components, `shipConsoleRoutes({ canActivate })` and a standalone root. The customized golden consumer mounts the console, refuses its `operator` role on every console operation, and retries a dead-lettered run, pauses and resumes through the control table, and replays a Stripe receipt from the console against real PostgreSQL. See [docs/v4/features/console.md](../v4/features/console.md).
- Accepted [ADR-0022](./decisions/0022-declared-managed-storage.md): declared managed storage (SAPI-754). `@sixthsummit/ship-core` gains `defineAttachment` (single/many, content types, size, visibility, image variants, intent TTL), `attachments` on modules and operations with a transaction-scoped `attachment.binding` capability the executor binds like an outbox writer, compile diagnostics (`SHIP_ATTACHMENT_*`, `SHIP_OPERATION_ATTACHMENT_*`), the `StorageAdapter` and `AttachmentLedger` contracts, and graph projection; `@sixthsummit/ship-contract` projects `attachments` (policy only, no provider detail) and types them in `ApplicationContractOf`. The new `@sixthsummit/ship-storage` package mounts `ship-storage`: `create-intent` (signed direct PUT), `complete` (actor-bound, provider-verified, atomically fenced against the sweep so a late completion never resurrects an abandoned upload), the `sweep` single-runner job (abandoned intents and never-attached uploads), the `ship-storage.purge` outbox whose `purge-object` intents are recorded inside the consumer's write transaction by `detach()` and made idempotent by a purge-ledger row, and the lazy `generate-variant` job backed by an injected `ImageProcessor` and the cache capability; adapters for local disk (HMAC-signed URLs served by a fetch handler), S3/R2/MinIO (in-house SigV4 over Web Crypto, no SDK) and GCS (injected client), plus `/hono` transports. `@sixthsummit/ship-drizzle` adds `shipStorageIntentsTable`, `shipStorageObjectsTable`, `shipStoragePurgesTable` and `createDrizzleAttachmentLedger` (claims with `FOR UPDATE SKIP LOCKED`, attach/detach joining the unit of work), proven against real PostgreSQL including rollback; `@sixthsummit/ship-testing` adds the in-memory adapter and ledger and `storageAdapterConformance`, which the disk and in-memory adapters pass. `@sixthsummit/ship-angular/storage` adds `createAttachmentUpload` (policy validation from the manifest, intent, PUT with progress, completion, settled `object` signal). The customized golden consumer declares `portfolio.photo` with attach/remove/list operations and proves the signed flow, the induced-orphan sweep, the late-completion fence and the commit-then-dispatch purge against PostgreSQL.
- Declared transactional mail (SAPI-756, [ADR-0023](./decisions/0023-declared-transactional-mail.md), [`docs/v4/features/mail.md`](../v4/features/mail.md)). `@sixthsummit/ship-core` gains `defineMailer` (typed messages with pure `render(payload) => { subject, html, text }` templates and samples), `defineModule({ mailers })`, graph projection (`graph.mailers`, `SHIP_MAILER_ID_DUPLICATE` / `SHIP_MAILER_ID_MISMATCH`), the `MailProvider` / `MailLedger` / `MailInterceptor` contracts and an `adaptedJobDependency` hook so a job enqueue token can resolve to a typed facade. `@sixthsummit/ship-contract` projects mailer ids and message names only. New `@sixthsummit/ship-mail`: `defineMailDelivery` compiles the `mail.deliver` job on the jobs capability with a typed `MailSender`, per-send idempotency key (enqueue dedupe plus a ledger claim so a replayed run never calls the provider twice), `allowlistInterceptor` with `X-Ship-Original-To`, `defineMailPreview`, `logMailProvider`, an in-memory ledger, a `fetch`-based Resend adapter forwarding `Idempotency-Key`, and provider/ledger conformance suites. `@sixthsummit/ship-drizzle` adds `shipMailSendsTable()` / `createDrizzleMailLedger()` (`ship_mail_sends`, GIN-indexed recipients). Evidence: kernel, contract, mail and drizzle unit suites; conformance against the log and Resend providers and the in-memory and PostgreSQL ledgers; a PostgreSQL integration lane proving enqueue → drain → replay yields one ledger row and one provider call and that eight concurrent claims on one key yield one claim; the customized golden consumer gains `reports.mailer`, `reports.email`, the `mail` module, the interceptor case and the same PostgreSQL proof.
- Accepted [ADR-0021](./decisions/0021-schema-safety-gates.md): schema safety gates (SAPI-759). New optional package `@sixthsummit/ship-schema-lint` lints Drizzle PostgreSQL migrations in journal order against the production column rules (`table-drop`, `table-rename`, `column-drop`, `column-rename`, `column-type-change`, `not-null-without-default`, `set-not-null`, `non-concurrent-index`, `backfill-in-ddl-transaction`) with a safe recipe per finding, justified allowlist entries (file or inline), `baseline` adoption, JSON output and stable exit codes; captures a canonical `pg_catalog` schema snapshot and fails on drift; ships the gated release preset (`release`: guard, lint, `drizzle-kit migrate`, snapshot) that refuses to run without `SHIP_RELEASE_STEP=1`, the `assertMigrationsApplied()` boot guard that never applies migrations, and the composite action `.github/actions/schema-safety`. Fail-and-pass fixtures per rule, CLI and release tests, a real-PostgreSQL test that catches an induced hand edit, and the customized golden consumer wired with generated migrations, a committed snapshot, lint in its `check` gate and a snapshot integration test. Documented in `docs/v4/features/schema-safety.md`.
- Completed the framework side of declared HTTP 3xx redirect results (SAPI-653, [ADR-0005 addendum](./decisions/0005-http-wire-and-representation-contract.md#addendum-2026-10-22-declared-3xx-redirect-results-sapi-653)). `defineOperation` now rejects a redirect output schema that cannot produce an empty body at definition time, the executor and Hono suites pin the full `Location` rejection matrix (protocol-relative, backslash, credentials, non-HTTP schemes, whitespace, control characters, CR/LF), every redirect status, `POST` to `303`, safe header pass-through, handler-chosen failure redirects next to JSON declared/validation/401 failures, and the mixed scalar/bracket `first-value` callback query. A new parity test proves the kernel projection matches the compatibility `c.redirect()` + `c.req.query()` callback on status, `Location`, empty body and absent content type. `@sixthsummit/ship-angular` exposes `location` on `ResponseMetadata`, reports an opaque browser redirect as `ProtocolError` reason `opaque-redirect`, and the packed conformance fixture executes a `302` case. The Vault Drive callback mapping (SAPI-138/SAPI-443) remains the consumer gate.
- Recorded [proposed ADR-0020](./decisions/0020-current-architecture-agent-tooling.md): an implementation inventory and replacement design for the compatibility MCP server and Claude plugin, using existing operation graph/contract tooling, explicit retirement boundaries, deferred execution/tracing, and executable delivery gates. This records the proposal, not an implemented replacement.
- Fixed outbox receipts stranded after an intent ID is removed during a rolling change (SAPI-426, [ADR-0014 addendum](./decisions/0014-actor-kinds-and-durable-outbox-delivery.md#addendum-2026-09-23-receipts-with-removed-intent-ids-sapi-426), [PR #154](https://github.com/SixthSummit/ship-api/pull/154)). Dispatchers now claim unknown IDs through a separate atomic backend method and dead-letter them for inspection without invoking an effect or claiming another partition's valid work. Empty probes pause for five seconds; discovered obsolete work drains alongside current intents. PostgreSQL tests cover persisted receipts, restart, retry, and partition isolation. Published to the `alpha` dist-tag as `@sixthsummit/ship-core`, `ship-drizzle`, and `ship-testing` `1.1.0-alpha-20260923190905` after the `dev` CI gate passed.
- Fixed the Hono adapter reporting client-aborted operations as unexpected 500s (SAPI-104): when the request signal is aborted, the adapter answers a bodiless `499` with the request id and skips the `onUnexpectedError` observer, since the executor already cancelled the operation on the same signal and no client remains to read a body.
- Hardened the PostgreSQL test helper against teardown races (SAPI-115): `createPostgresTestPool()` attaches the `pg.Pool` error listener so a container stop that reaches an idle client no longer surfaces as an uncaught `57P01` after a passing suite; the multiprocess job-backend test reads its event log in insertion order.
- Fixed the two outbox findings of the M10 capacity baseline (SAPI-114, [ADR-0014 addendum](./decisions/0014-actor-kinds-and-durable-outbox-delivery.md#addendum-2026-09-18-claim-cost-under-a-backlog-and-the-adaptive-dispatch-runner-sapi-114), [ADR-0017 addendum](./decisions/0017-declared-realtime-publication.md#addendum-2026-09-18-the-publication-runner-shares-the-adaptive-outbox-loop-sapi-114)). `@sixthsummit/ship-drizzle`'s claim no longer sorts every due row: `shipOutboxTable()` gains the partial indexes `ship_outbox_pending_idx` (`outbox_id, available_at, created_at` where pending) and `ship_outbox_lease_idx` (`outbox_id, lease_expires_at` where claimed), and `claimDue` retakes lease-expired rows first then fills the batch from pending rows through two ordered index scans with `FOR UPDATE SKIP LOCKED`; the `EXPLAIN (ANALYZE, BUFFERS)` plans and the before/after latency (200k pending: 71 ms to 4.8 ms per 25-row claim) are in the addendum, and a load-shaped integration test seeds 1k and 200k rows and bounds the p95. `@sixthsummit/ship-core` adds `startOutboxDispatchRunner(executor, "<outbox>.dispatch", { intervalMs?, maxPassesPerCycle?, backoff?, observer?, onError? })`, the adaptive loop behind `startRealtimePublicationRunner`: a full batch is followed by the next pass at once (bounded by `maxPassesPerCycle`), a short or empty batch waits the interval, and `OutboxDispatchResult` carries `batchSize`; `dispatchOutbox` is the one pass and `OutboxRunnerError` its error family. `defineOutbox({ expectedRatePerSecond })` and `defineOutboxDispatcher({ roundsPerSecond })` (also on the realtime publication module) let the compiler warn `SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE` and project `expectedRatePerSecond` and `dispatchCapacityPerSecond` on outbox graph nodes. The capacity harness's workers drive the four dispatchers through the shared runner (`CAPACITY_DISPATCH_PASSES_PER_CYCLE` is new), and the 60 s run at default settings now drains the outbox within the drain window; the customized golden consumer declares its expected report rate and drains a 51-record backlog adaptively.
- Made the PostgreSQL job backend's integration tests deterministic under CPU contention (SAPI-115). `jobBackendConformance` in `@sixthsummit/ship-testing` now waits for `health()` to report a run neither waiting nor active before asserting settled counts or sweeping retention, because a handler's return precedes the backend's completion write; the two-process Drizzle test waits on the run ledger (every `fixture.serial` row `completed` with its claim token cleared) rather than on the handlers' own end events, and the serial fixture handler is a barrier that holds its key until it has observed another key's run in progress, so cross-key overlap is a property the backend must deliver rather than one the scheduler happens to produce. No backend code changed; the health read that observed `active: 1` after the handler returned is the documented at-least-once ordering (outcome recorded after the handler resolves), not a gap.
- Improved realtime conformance ([ADR-0017 addendum](./decisions/0017-declared-realtime-publication.md#addendum-2026-09-18-realtime-refinements)) and the webhook replay re-run finding ([ADR-0018 addendum](./decisions/0018-inbound-webhook-operations.md#addendum-2026-09-18-replay-path-parameter-name)). Presence answers `actorOnline` cluster-wide and pages `snapshot` with `cursor`/`limit`, a whole-membership `count`, a bounded page (default 100, maximum 1,000) and `nextCursor`; both backends page through the kernel's `pagePresenceMembers`, the conformance suite asserts both, and the wire gains `ship:presence.online` plus paging fields and `INVALID_PAGE` on `ship:presence.snapshot`. `createChannelPublisherRegistry(channels | app, backend)` derives every publisher from the declarations and `defineRealtimePublicationModule` exposes its registry as `publishers`; `AnyChannelPublisher`, `isChannelPublisher` and `narrowChannelPublisher` give generic bridges a runtime-validated erased publish and a typed way back. `executor.tryRun()` returns the HTTP adapter's 500 envelope (`OperationExecutionFailure`, with `cause`) where `run()` throws, without changing `run()`. `dispatchRealtimePublications` is the one dispatch pass; `startRealtimePublicationRunner` (interval, bounded bursts, failure backoff, graceful stop, `runOnce`) runs it without the jobs capability, `defineRealtimePublicationDispatchJob` runs it as a declared single-runner job, and `@sixthsummit/ship-realtime-socketio` adds `createPublicationRunnerMetrics` (`ship.realtime.publication.*`, shaped like `ship.job.*`). The kernel names the manifest projection convention (`ProjectableRuntimeSchema`, `CONTRACT_SCHEMA_METADATA_KEY`, `NATIVELY_PROJECTED_SCHEMA_VENDORS`, `isManifestProjectable`), warns `SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE`, projects `payload.projectable` on channel graph nodes, types module `channels` per module (`defineModule` overloads keep an omitted list the empty tuple), and `ApplicationContractOf` gains `channels` with `ChannelPayloadNotProjectable<id>` for a payload the manifest cannot derive. `defineWebhookReplay` accepts any single `:name` path parameter as the event id, with an optional `transport.eventIdParameter` cross-check, so a legacy `/webhooks/:id/retry` route keeps its id in the URL. The customized golden consumer adds a legacy call-site bridge (registry publish, narrowed publish, `tryRun`, the standalone runner), declares plain Zod channel payloads, pages presence and mounts replay on `/webhooks/:id/retry`.
- Improved declared caching and jobs conformance ([ADR-0019 addendum](./decisions/0019-declared-read-cache.md#addendum-2026-09-18-cache-scoping-refinements), [ADR-0015 addendum](./decisions/0015-declared-jobs-and-schedules.md#addendum-2026-09-18-job-backend-refinements)). `Cache-Control` projects `public` only for `publicAccess()` reads (`SHIP_CACHE_PUBLIC_SCOPE_PROTECTED` warning, `SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN` error for optional identity); `invalidates` accepts `{ tag, scope: "actor" | "tenant" }` entries that purge one subject's entries through a scope-qualified tag while plain tags stay global (`SHIP_CACHE_INVALIDATES_ACTOR_INVALID`, `SHIP_CACHE_TAG_SCOPE_UNMATCHED`, `invalidatesScoped` on the graph, proven against real Redis); `vary(input, subject)` sees the actor and context (`SHIP_CACHE_VARY_SUBJECT_PUBLIC`); `defineCacheInvalidationModule({ backend })` binds and exports the cache backend token so consumers bind nothing; `cacheBackendConformance` proves scoped tags stay independent; `ship-api inspect app|module` lists declared and framework-introduced permissions and the kernel README documents `ship.outbox:manage`, `ship.jobs:manage` and `ship.webhooks:replay`. Jobs accept `retention.completedMs: 0` (collect on the next sweep), `startJobRuntime` exposes per-job `liveness()` (`lastStartedAt`/`lastCompletedAt`/`lastFailedAt`/`lagMs`) and `ship-hono` projects it with `jobLivenessRoute`, and the module/id diagnostic names the job and `defineJobManagement` prefix rule.
- [ADR-0018](./decisions/0018-inbound-webhook-operations.md) addendum, response modes and replay transport, for the framework: `defineWebhook` declares `response: json | text | binary | empty` with a compiled content type so providers that execute the acknowledgement (TwiML `text/xml`, bodiless status callbacks) are declared rather than bridged; `ship-hono` settles the representation from the transport before `respond({ headers })` and answers `empty` bodiless while every failure stays the JSON envelope; `ship-contract` projects the mode into `x-ship-webhook` and OpenAPI (`text/xml`, no content); `defineWebhookReplay` accepts `transport: { path }` so replay mounts through the adapter under `ship.webhooks:replay` with `:eventId` or a JSON body. The customized golden consumer answers Twilio with TwiML, acknowledges a status callback with an empty 200 and mounts replay behind an operator session. Response modes do not compose with [ADR-0016](./decisions/0016-streaming-response-representation.md) streaming or the [ADR-0019](./decisions/0019-declared-read-cache.md) read cache: `stream` is not a webhook mode and `cache` on a webhook or replay is `SHIP_WEBHOOK_CACHE_FORBIDDEN`.
- Composed transactional realtime publication with the ADR-0014 outbox ([ADR-0017 addendum](./decisions/0017-declared-realtime-publication.md#addendum-2026-09-18-outbox-composition)). `@sixthsummit/ship-core` gains `defineRealtimePublicationOutbox` (the fixed `ship-realtime.publication` outbox with one intent per channel), `defineRealtimePublicationDispatcher` and `defineRealtimePublicationModule` (module `ship-realtime`: outbox writer, per-channel publishers, dispatcher, dead-letter and cleanup operations); a `transaction: "write"` operation that declares `publishes` records validated publication intents in its own unit of work and the dispatcher publishes them after commit, `SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING` replaces the transaction-forbidden diagnostic for write publishers (read publishers stay forbidden), generated outbox dispatchers declare channel tokens under `publishes`, and the graph marks each publishing operation's `publicationDelivery`. `@sixthsummit/ship-testing` adds `drainRealtimePublications`. Real PostgreSQL + Redis + Socket.IO evidence covers commit-then-dispatch delivery, rollback, crash recovery and `dedupeKey`; the customized golden consumer publishes `reports.requested` from its write request. Delivery is eventual and at-least-once by contract.
- Accepted [ADR-0015](./decisions/0015-declared-jobs-and-schedules.md): `defineJob` compiles schedule/interval/enqueue/http-triggered jobs into system-actor operations in the same graph and executor as HTTP work, with per-key single-runner leases through a `LockProvider`, bounded retry, `queue-full` backpressure, `jobDependency` job-to-job edges, `ship.jobs:manage` dead-letter operations, a keyed single-runner retention sweep that also covers outboxes, and `startJobRuntime` worker modes. `@sixthsummit/ship-jobs-bullmq` (BullMQ backend, Redis lock, `ship.job.*` OpenTelemetry metrics), `advisoryLockProvider` in Drizzle, `httpJobTrigger`/`jobTriggerActorResolver` in Hono, the in-memory backend plus `runJobOnce` and `jobBackendConformance` in testing, and `ship-api inspect job` land together. Two-process single-runner, crash/restart at three points (at-least-once asserted), cleanup and metrics are proven against real Redis and PostgreSQL; the customized golden consumer runs a scheduled digest and an enqueued delivery job.
- Accepted [ADR-0017](./decisions/0017-declared-realtime-publication.md): declared realtime publication. `@sixthsummit/ship-core` gains `defineChannel` (actor/tenant/resource scopes, per-channel publication effect tokens, `publishes` on operations, stable compile diagnostics, graph projection), the transport-neutral `RealtimeBackend` contract, kernel-owned subscription authorization, and a shared publication coalescer; `@sixthsummit/ship-contract` projects `channels` and `publishes` without transport detail; `@sixthsummit/ship-testing` ships the in-memory backend, `collectPublishes()`, the `realtimeBackendConformance()` suite, and a raw-WebSocket smoke fixture; the new `@sixthsummit/ship-realtime-socketio` package provides the Socket.IO + Redis gateway (handshake through the application's actor resolver, gateway mode, Redis-backed presence with dead-gateway sweeping, coalescing, bounded per-connection send buffers, control-message limits, OpenTelemetry metrics) with multi-process evidence recorded in the ADR. Transactional publishes will compose with the ADR-0014 outbox through a publishing dispatcher, which remains a marked TODO.
- Accepted [ADR-0019](./decisions/0019-declared-read-cache.md): per-operation `cache: { ttlMs, scope, vary?, tags?, tenant? }` on read operations with framework-derived keys (operation id, graph version, actor id or authentic `TenantScope` identifier, canonical validated input, `vary`), `invalidates` on writes recording durable purge intents through the framework-owned `ship-cache.invalidation` outbox inside the write transaction, and a `CacheBackend` contract (`get`/`set`/`del`/`delByTag`/`health`) bound with `cacheBackendDependency()`. `@sixthsummit/ship-cache-redis` ships the Redis adapter, `@sixthsummit/ship-testing` an in-memory LRU backend plus `cacheBackendConformance`; `ship-hono` emits `x-ship-cache` and the declared `Cache-Control`, the contract and OpenAPI carry the policy, and `ship-api inspect`/`affected` expose cache policy and tag edges. Durable invalidation is proven against real PostgreSQL, the Redis adapter against real Redis, and the customized golden consumer caches a tenant read and invalidates it.
- Accepted [ADR-0018](./decisions/0018-inbound-webhook-operations.md): inbound webhook operations. `defineWebhook` compiles a bounded raw-body POST with `providerAccess`, a pure `WebhookVerifier` contract with explicit signature/freshness/replay guarantees, rotatable secret sources, executor-enforced idempotency with a declared in-flight policy, and inline or enqueue (receive-then-process) modes; `ship-hono` verifies exact bytes before any actor exists and derives canonical URLs from the declared public base URL; `ship-drizzle` and `ship-testing` add the `ship_webhook_events` store and its in-memory twin plus a fake provider proving consumer-defined verifiers bind through the public contract; `ship-contract` excludes webhooks from the browser manifest and documents them under `x-ship-webhook`; `ship-observability-otel` records receive, verification-failure, duplicate and receive-to-dispatch metrics; and the new optional `@sixthsummit/ship-webhooks` package ships Stripe, GitHub, Slack, Twilio, Resend, HighLevel (Ed25519/RSA public-key) and shared-secret verifiers behind independent subpaths. Live PostgreSQL tests prove two-process replay, in-flight policies, crash safety, burst latency, store-down 503s and retention; the parity suite proves identical accept/reject decisions against the compat `parseWebhook` + `idempotency()` composition and records the ordering divergence the kernel closes.
- Accepted [ADR-0014](./decisions/0014-actor-kinds-and-durable-outbox-delivery.md): explicit `human`/`system`/`provider` actor kinds with `systemAccess()`/`providerAccess()`, a durable transactional outbox (`defineOutbox`, `outboxDependency`, `defineOutboxDispatcher`, `defineOutboxCleanup`, `OutboxBackend`) with at-least-once delivery, and executor-enforced operation idempotency (`IdempotencyStore`, `IDEMPOTENT_IN_FLIGHT`). Drizzle adapters (`createDrizzleOutbox`, `createDrizzleIdempotencyStore`) are proven against real PostgreSQL; `@sixthsummit/ship-testing` gains in-memory backends and `drainOutbox`; the customized golden consumer exercises the full path.
- Accepted [ADR-0016](./decisions/0016-streaming-response-representation.md): HTTP operations declare `response: { mode: "stream", framing: "sse", frame, heartbeatMs, maxDurationMs, maxFrames }`; the kernel validates frames through a handler `stream.emit`/`stream.signal` seam and rejects transactional, unbounded, or idempotent streams; the Hono adapter owns `text/event-stream` framing, reader backpressure, heartbeats, limit and terminal error frames, and client-abort propagation; the manifest, fingerprint, and OpenAPI carry the frame/terminal schemas; the structural client returns a browser-safe `{ frames, terminal, abort, status, error }` handle with an incremental SSE parser. The wire contract is frozen in [docs/v4/streaming.md](../v4/streaming.md), a parity test proves byte-identical output against the compatibility `streamSSE` helper, and the customized golden consumer streams a tenant-scoped progress operation.
- Accepted [ADR-0013](./decisions/0013-primitive-form-projection-and-joint-fixture.md): explicit primitive form bindings and reproducible real joint artifacts. The retained Angular gate now verifies strict generated types, HTTP results/errors, browser cookie refresh/replay, cancellation after I/O and overlapping Angular SSR documents; non-JSON/advanced-codec/server-retry roadmap work remains explicit.

- Opened the rearchitecture program from `dev` at `9022c8fc922f773dd723921edd5973ec81bf283b` on branch `rearchitecture/agent-native-framework`.
- Added the [agent-native application-kernel RFC](../AGENT_NATIVE_REARCHITECTURE_RFC.md).
- Added [ADR-0001](./decisions/0001-operation-centric-application-kernel.md), accepting an operation-centric application kernel as the redesign direction.
- Established this architecture decision record and changelog process.
- Reworked the repository commit template around the company Conventional Commits guide while preserving Changesets as the actual versioning mechanism.
- Added a pull request template covering contract, testing, coverage, security, release, risk, rollback, and review evidence.
- Added and accepted [ADR-0002](./decisions/0002-pnpm-first-defer-turborepo.md): migrate the framework monorepo to pnpm before the package split and defer Turborepo until task measurements justify caching and orchestration.
- Migrated the framework repository to a pinned pnpm workspace with one shared lockfile, strict peer checks, explicit workspace links, an install-script allowlist, and reusable CI setup.
- Added isolated production-manifest audits for framework runtime and documentation trust zones, including a bounded scanner timeout so a stalled advisory service cannot hang CI indefinitely.
- Added pinned Biome checks as the repository's formatter, import organizer, and broad static-analysis gate, while retaining ESLint only for focused architecture boundaries that Biome cannot express.
- Added executable repository-policy tests proving that raw Hono input and ORM value imports are rejected outside their owned layers.
- Added first-class edge-bundle and packed-consumer smoke scripts. The edge fixture is now an explicit private workspace with pinned Wrangler dependencies, and the pack fixture always installs outside the workspace before booting the public API.
- Added the first additive application-kernel primitive: immutable `defineOperation` declarations with Standard Schema input/output inference, explicit access and transaction modes, stable error codes, typed dependency tokens, transport metadata, and runtime definition diagnostics.
- Added [ADR-0003](./decisions/0003-operation-results-and-errors.md), accepting status-indexed success schemas, a terse default-body return, typed alternate `respond(...)` results, and value-based declared client failures.
- Added explicit immutable module and provider declarations. Modules own operation/provider lists plus named imports and exports; provider factories receive only declared typed capabilities and select singleton or operation lifetime.
- Added `defineApp`/`compileApp` as the application graph boundary. Compilation aggregates stable diagnostics for duplicate ownership/bindings, missing/private providers, undeclared imports, namespace violations, and module/provider cycles.
- Added deterministic, JSON-safe graph projections and immutable typed module, operation, and provider lookups as the single source for later CLI, client, OpenAPI, and impact views.
- Added the transport-independent `createExecutor` path. It enforces access before work begins, validates/transforms Standard Schema inputs, resolves singleton and operation-scoped provider graphs, validates every success/error result, propagates cancellation and request identity, and requires no HTTP server.
- Added reusable `operationError`/`operationFailure` declarations so error code, status, safe message, and optional detail schema are graph-visible and shared across handlers, HTTP, OpenAPI, and clients.
- Added immutable `http.get/post/put/patch/delete/options` transport declarations and `createHonoAdapter`. Hono routes are now a projection of compiled operations; the adapter translates path, query, lower-case header, and JSON body locations before calling the same direct executor.
- Added explicit `@sixthsummit/ship-api/kernel` and `@sixthsummit/ship-api/hono` package subpaths for the edge-safe seam.
- Added [ADR-0004](./decisions/0004-credential-actor-and-access-boundary.md), separating transport credential extraction, per-operation actor resolution, immutable permission snapshots, and authoritative kernel access checks.
- Added typed Hono credential adapters and `honoAuthProvider()` as the narrow migration bridge for current v4 authentication providers.
- Added [ADR-0005](./decisions/0005-http-wire-and-representation-contract.md), fixing the HTTP error envelope, validation issue shape, request parsing limits, representation modes, response-header ownership, and unexpected-error behavior.
- Added explicit JSON, text, and binary response declarations, safe per-result headers, strict UTF-8 JSON parsing, a configurable 1 MiB request-body limit, and a failure observer that cannot alter the client response.
- Added [ADR-0006](./decisions/0006-executable-transaction-scopes.md), making operation transaction modes control execution rather than document an optional handler convention.
- Added a Drizzle unit-of-work adapter that constructs frozen transaction-scoped capabilities, enforces PostgreSQL read-only/read-write modes, joins nested calls deterministically, marks joined failures rollback-only, and rejects nested write escalation.
- Added `unitOfWorkDependency()` plus compiler and executor support, so transactional operations require exactly one graph-visible controller and handlers receive its scoped repositories instead of the controller or base connection.
- Added [ADR-0007](./decisions/0007-domain-repositories-and-named-projections.md), rejecting a replacement universal CRUD layer in favor of explicit transaction-built domain repositories.
- Added typed Drizzle primitives for bounded offset pagination, immutable page results, configurable audit and soft-delete fields, and closed named projection query functions.
- Added [ADR-0008](./decisions/0008-authorized-tenant-capabilities.md), requiring application-authorized tenant scopes, separately typed privileged repositories, and fail-closed bypass auditing.
- Added nominal tenant capabilities and transaction-captured repository factories. Normal scopes require an authenticated operation actor plus an application membership policy; privileged scopes require separately issued evidence whose issuance and repository use are both audited.
- Added `ship-api check`, `inspect`, and `affected` as direct projections over the compiled application graph, with deterministic human/JSON output, stable diagnostics, explicit exit classes, TypeScript config loading, and optional `.ship/graph.json` emission.
- Added [ADR-0009](./decisions/0009-client-safe-contract-projections.md), replacing Hono's chained route type as the target frontend contract with a graph-derived manifest, OpenAPI 3.1 projection, and structural operation client.
- Added `contractSchema()`, deterministic SHA-256 contract fingerprints, explicit client codecs, and stable projection diagnostics for schemas that cannot be represented safely.
- Added `createHttpOperationClient()` with operation-ID/input/result inference, value-based declared and framework failures, exact response metadata, JSON/text/binary handling, request cancellation, and protocol diagnostics.
- Added `ship-api contract` to atomically emit deterministic `.ship/contract.json` and `.ship/openapi.json` artifacts from `ship.config.ts`.
- Published the operation/module/provider/application kernel as the dependency-free `@sixthsummit/ship-core` workspace package; the legacy `/kernel` subpath is now only a compatibility re-export.
- Published operation-derived HTTP routing and credential extraction as `@sixthsummit/ship-hono`; the legacy `honoAuthProvider()` bridge remains only in `@sixthsummit/ship-api`, preventing the new adapter from depending on the monolith's auth model.
- Published parity fixtures and the real PostgreSQL harness as the development-only `@sixthsummit/ship-testing` trust zone; runtime packages do not depend on Testcontainers or Drizzle Kit.
- Published transaction execution and repository construction as `@sixthsummit/ship-drizzle`; the dependency-free kernel no longer shares a package boundary with an ORM or database driver.
- Published the browser-safe client and backend-only contract projectors as explicit `@sixthsummit/ship-contract` entrypoints; frontend consumers no longer need the server monolith or a Hono route-tree type.
- Added `@sixthsummit/ship-auth-firebase` with strict bounded bearer parsing, opt-in trusted-proxy credentials, Firebase verification, and application-owned actor/permission resolution; the legacy account-shaped Firebase provider remains available to current v4 consumers.
- Published tracing, Node SDK lifecycle, and Prometheus metrics as explicit `@sixthsummit/ship-observability-otel` entrypoints; the kernel, HTTP, contract, and database packages remain telemetry-free.
- Published application graph validation, inspection, impact analysis, and
  contract generation as `@sixthsummit/ship-cli`; its standalone command does
  not load the legacy scaffold or migration toolchain.
- Made every compiled package remove its own generated `lib` and incremental
  state before emitting, eliminating stale files after source moves. Root and
  CI builds now run the complete topologically ordered package graph instead of
  compiling the monolith in isolation.
- Replaced the monolith-only packed-consumer smoke with an installed package-
  graph gate that validates archive surfaces, manifest targets, public runtime
  behavior, CLI execution, contract fingerprints, and TypeScript inference
  across every publishable workspace.
- Added a standalone minimal golden consumer with its own Biome, TypeScript,
  unit, build, and real-PostgreSQL gates. It composes a protected read and
  transaction-scoped write through public kernel, Hono, Drizzle, contract, and
  testing packages only.
- Added [ADR-0010](./decisions/0010-declared-immediate-effects.md) and
  `effectDependency()`. External clients are now direct operation capabilities
  with graph-visible immediate delivery instead of ordinary providers that can
  hide side effects.
- Added a standalone customized golden consumer that owns its session
  credentials, role mapping, tenant-membership policy, aggregate SQL, and
  notification adapter. Its only framework coupling is the public operation,
  Hono, Drizzle, contract, and testing package surface.
- Added `ship-api migrate-routes` and a programmatic route-migration checker.
  Candidate-SHA legacy catalogs now require exactly one operation mapping or
  approved removal per source route, with exact HTTP method/path verification
  against the compiled application graph.
- Added [ADR-0011](./decisions/0011-explicit-bounded-request-bodies.md) and explicit
  per-operation JSON, raw, and multipart request-body policies. Policies carry
  total and part limits through the application graph, client manifest,
  generated client, and OpenAPI instead of hiding them in route middleware.
- Added [ADR-0012](./decisions/0012-v4-replacement-and-release-boundary.md),
  choosing the replacement kernel as the v4 GA target while retaining the
  current v4 surface as an incremental compatibility distribution.
- Replaced the pre-redesign public-surface and versioning claims with the
  focused-package ownership, operation/wire contracts, independent package
  versions, and explicit v4 compatibility tier accepted by ADR-0012.
- Reconciled the release documentation with the 11-package Changesets graph,
  automated Version Packages workflow, exact consumer pins, full verification
  gate, and no-traffic consumer acceptance boundary.
- Added a retained local candidate packer that binds the complete ShipAPI graph
  and additional framework/application-contract packages into one sorted,
  fingerprinted manifest. It rejects uncommitted package sources and records
  source commits, versions, portable archive paths, sizes, and SHA-256 identities
  without publishing or overwriting an existing candidate directory.
- Raised the repository, testing package, and PostgreSQL golden-consumer Node.js floor to 22.22 so
  the declared engine matches the locked Testcontainers/Undici requirement and fails before a
  long package gate begins on an unsupported Node 22 patch.
- Raised the workspace and generated-consumer pin to pnpm 10.34.5 and added a publish-time
  dependency sorter after both pnpm 10.8.1 and 10.34.5 produced alternating `workspace:` dependency
  order in otherwise unchanged archives. The packed-package gate now rebuilds and packs all 11
  publishable workspaces twice and requires matching versions, byte sizes, and SHA-256 identities.
- Replaced the stale route-registry/`hc()` launch pitch, post-cutover status, and
  root README with the implemented operation graph, focused package map,
  measured gates, compatibility boundary, and remaining adoption work.
- Added the focused CLI's operation-native `create` path. Its minimal generated
  application carries exact release-manifest pins, executable graph/contract
  tooling, strict TypeScript, Biome, reviewed Vitest examples, 80% coverage
  thresholds, `AGENTS.md`, and repository contribution templates.
- Made the packed-package gate scaffold outside the workspace, install physical
  archives, and pass the generated project's complete verification command.
- Corrected the structural Standard Schema boundary so current Zod validators
  remain assignable under `exactOptionalPropertyTypes`.
- Replaced the public quick start, project structure, HTTP model, ShipAngular,
  and React Native guides with the focused operation contract. Public pages for
  monolithic services, middleware, features, generators, and agent tooling now
  identify themselves as compatibility surfaces.
- Replaced the former 1,148-line mechanical v3 migration walkthrough with the
  operation-slice path: exact release sets, executable route accounting,
  physical-schema preservation, representative pattern gates, structural
  frontend contracts, and no-traffic promotion.

### Changed

- Prepared framework-only public documentation: removed private application evidence and migration inventories, retained framework ADR decisions and package release entries, and replaced application-derived regression fixtures with synthetic inputs.

- Reframed agent-native development around typed code, compiled invariants, structured diagnostics, and executable tests rather than prompt or skill compliance.
- Corrected repository documentation that described Changesets as `release-please`, commit conventions as enforced, and a suggestion-only PostToolUse reviewer hint as automatic enforcement.
- Split security decisions into a hard published-runtime gate and separate documentation/tooling maintenance scans.
- Removed the disabled-Issues dependency-update path and the license job that could not enforce a policy.
- Allowed scheduled audit remediation to open a lockfile PR even when residual advisories remain for CI to report.
- Made integration, edge-smoke, and skills-sync results explicit dependencies of the CI summary.
- Converted CI, release, dependency-update, security, maintainer, contributor, and repository-agent commands to pnpm without imposing pnpm on generated consumer applications.
- Declared reference-module runtime dependencies and integration-test tooling explicitly after pnpm correctly exposed dependencies previously supplied by npm's root hoisting.
- Preserved Changesets publication behavior and changed the MCP server's package lifecycle build to use the pinned workspace package manager.
- Replaced overlapping Prettier and general-purpose ESLint configuration with one `check` command and explicit `verify:fast` and `verify` gates.
- Mechanically formatted and organized existing TypeScript/JavaScript sources under Biome without intentionally changing their public behavior.
- Corrected two Resend test doubles to remain constructable under Vitest; the legacy email suite caught the unsafe function-to-arrow transformation during the full gate.
- Changed audit timeout handling to terminate the entire spawned process group, so a stalled advisory client cannot survive its bounded gate.
- Replaced the edge smoke's raw-Hono-only worker with a real declared operation compiled through the ShipAPI kernel and Hono adapter.
- Generated Hono routes now resolve actors and perform the shared kernel access check before reading a protected request body; the executor repeats the same check so non-HTTP execution cannot bypass it.
- Made `details.issues` a stable validation wire contract and defined additive versus breaking compatibility rules for consumers and generated clients.
- Moved declared failure normalization outside the transaction boundary so expected application failures roll back before becoming result values.
- Replaced framework assumptions about `createdAt`/`updatedAt`/`deletedAt` with table-checked semantic mappings that also support legacy names such as `createdDate`/`updatedDate`/`deletedDate`.
- Upgraded the shipped OpenTelemetry runtime as one coherent release line: `sdk-node` and exporters use 0.222, while resources, metrics, tracing, and the formerly vulnerable Jaeger propagator resolve to 2.11.
- Reserved framework-owned error codes against application declarations and made singleton, empty, and empty-string query arrays unambiguous through the client/Hono bracket encoding contract.
- Replaced the decorative OpenTelemetry side-effect import with an explicit
  instrumentation bootstrap and dynamic server load. Generated applications
  now start the SDK before ESM evaluates HTTP, database, Redis, and logging
  dependencies.
- Replaced the CLI's symlink-sensitive self-entrypoint heuristic with a
  dedicated bin module after the clean installed-consumer gate proved that the
  former executable could exit zero without running a command.
- Removed test, type-contract, example, and CLI-fixture material from compiled
  monolith output while retaining intentional scaffold source assets.
- Rejected immediate external effects inside database transactions and effect
  clients hidden behind provider factories. Durable delivery is modeled as a
  transaction-scoped outbox write plus a separately declared dispatcher.
- Narrowed protected-operation handler contexts so authenticated and
  permission-gated handlers receive a required actor in TypeScript, matching
  the executor's existing access-before-handler runtime invariant. Public
  handlers continue to receive an optional actor.
- Changed the Hono body reader to stop at its declared byte limit rather than
  materializing an unbounded request first. Protected requests still resolve
  identity and access before any JSON, raw, or multipart body work begins.
- Replaced the compatibility-package-only coverage command with one repository
  gate over focused packages, compatibility code, and shared libraries. All
  four coverage metrics now hard-fail below the company-standard 80% floor.
- Added the skills projection check to the authoritative `verify` command so
  local phase evidence and CI cannot silently accept stale generated guidance.
- Made the packed-package gate print the SHA-256 identity of every tested
  archive before its isolated fixture is removed.
- Reconciled execution readiness with the completed implementation: framework
  discovery is closed, while publication, real-client previews, named
  ownership, support, and traffic gates remain explicitly open.

### Evidence

- The two-client architecture boundary passes the complete framework gate on
  2026-09-07: 2,231 repository tests across 148 files, 88.51% statements, 83.22% branches,
  90.74% functions, 89.92% lines, 63 live PostgreSQL tests plus one skip, 11
  parity tests, the 192.50 KiB edge bundle, 839 files across 686,353 bytes of
  physical package archives, both golden consumers, the 41-page docs build,
  and a 408-dependency runtime audit with zero high or critical findings.
- The repository-wide coverage gate passes 2,231 tests across 148 files at
  88.51% statements, 83.22% branches, 90.74% functions, and 89.92% lines.
- The complete local release-candidate gate passes skills sync, TypeScript,
  all package builds, 2,231 repository tests, the 80% aggregate coverage gate,
  63 live PostgreSQL tests plus one skip, 11 parity tests, a 192.50 KiB edge
  bundle (43.10 KiB gzip), two byte-identical builds of the 11-package archive graph, the generated
  operation app, both golden consumers, 41 documentation pages, and a
  408-dependency runtime audit with zero high or critical findings.
- Changesets resolves the queued manifest to eight focused packages at their
  next `0.1.0-alpha.1` prerelease and the compatibility distribution at
  `4.0.0-alpha.7`; publication remains workflow-owned and has not occurred.

- The architecture records, contribution guide, pull request template, and source tree pass the repository's Biome and focused architecture checks.
- `git diff --check` reports no whitespace errors.
- The initial documentation-only baseline changed no runtime or package behavior.
- A clean frozen pnpm install, TypeScript, ESLint, Prettier, skills sync, build, 1,740 unit tests, 942 coverage tests, 47 integration tests (plus one intentional skip), 11 parity tests, and the 41-page documentation build pass.
- Framework coverage is 90.08% statements, 83.57% branches, 88.32% functions, and 92.54% lines.
- The packed `@sixthsummit/ship-api@4.0.0-alpha.6` artifact installs and boots in a dependency-clean temporary consumer; Changesets publication completes a GitHub Packages dry run with the `alpha` tag.
- Packed-artifact inspection exposed a pre-existing package-boundary problem: the core tarball contains 580 files, including test and reference-source material. The later package-split phase must reduce that surface and retain this measurement as its baseline.
- The npm advisory endpoint did not return during the local production audit attempt. The new audit remains a hard gate and now terminates after two minutes rather than hanging; advisory clearance requires a successful registry-backed run before release.
- Phase 1 tooling verification passes TypeScript, build, 1,745 unit/repository tests, 947 coverage tests, 47 integration tests (plus one intentional skip), 11 parity tests, the pinned Wrangler edge dry run, a clean packed-consumer install/boot, and the 41-page documentation build.
- Framework coverage remains 90.08% statements, 83.57% branches, 88.32% functions, and 92.54% lines after the migration.
- A three-second fault-injection probe proves the audit wrapper exits `124` and kills a stalled `audit-ci` process tree. The live advisory result remains unavailable and therefore unresolved rather than silently green.
- The operation declaration contract passes 38 focused runtime tests and a build-time inference contract covering transformed inputs, branded IDs, dependency services, literal error codes, and alternate success statuses.
- Module/provider declarations bring the focused kernel suite to 60 passing tests, with build-time contracts proving that service types and literal module/operation/import identifiers survive composition.
- Application compilation brings the focused kernel suite to 79 passing tests, including declaration-order determinism, graph serialization, diagnostic aggregation, module boundaries, provider cycles, and exact operation lookup types.
- Direct execution brings the focused kernel suite to 115 passing tests. The matrix covers input aggregation/transforms, auth ordering, all/any permissions, cross-realm read-only permission sets, declared and undeclared failures, invalid output/details, schema crashes, nested provider resolution, concurrent singleton initialization, operation scoping, retry after provider failure, cancellation, generated request IDs, and build-time call/result narrowing.
- The executor phase passes Biome, architecture lint, skills sync, TypeScript, build, and all 1,860 repository tests. Its 1,061-test coverage gate reports 91.39% statements, 85.04% branches, 90.03% functions, and 93.60% lines; the new kernel reports 96.95%, 90.53%, 95.53%, and 97.79% respectively.
- The 47-test integration suite (plus one intentional skip), 11-test parity suite, pinned Wrangler edge dry run, and 41-page documentation build remain green across the executor boundary.
- The dependency-clean packed consumer now compiles and directly executes a public operation contract in addition to booting the legacy Hono surface. The artifact passes at 636 files and 632,551 archive bytes, retaining package-surface reduction as an explicit package-split gate.
- The operation/Hono differential and adapter suites bring the focused kernel-plus-Hono matrix to 148 passing tests. It covers all JSON input locations, repeated query values, transforms, validation parity, declared failures, request IDs, 204 responses, safe unexpected failures, route configuration diagnostics, canonical paths, and collision parity.
- The real kernel/Hono Cloudflare Worker dry run passes under pinned Wrangler 4.129.0 at 136.39 KiB (31.12 KiB gzip); the previous nominal edge fixture was only bundling Hono itself.
- The generated-route commit passes Biome, architecture lint, skills sync, TypeScript, build, and all 1,894 repository tests. Its 1,096-test coverage gate reports 91.64% statements, 85.44% branches, 90.95% functions, and 93.97% lines; the new Hono adapter reports 94.85%, 90.41%, 100%, and 99.20% respectively.
- A dependency-clean packed consumer imports the explicit kernel/Hono subpaths and verifies both direct and generated HTTP execution. The packed artifact passes at 652 files and 639,998 archive bytes.
- The credential/actor boundary brings the focused kernel-plus-Hono matrix to 186 passing tests and the full repository to 1,931. Its 1,133-test coverage gate reports 91.95% statements, 86.04% branches, 91.33% functions, and 94.18% lines; the Hono seam reports 96.31%, 93.23%, 100%, and 99.42% respectively.
- Direct/HTTP matrices prove authenticated, anonymous, invalid, forbidden, unavailable, all-permission, and any-permission outcomes. A protected request with malformed JSON returns 401 without parsing the body or running the handler, while direct execution independently rejects the same missing actor.
- The actor-aware kernel/Hono edge bundle remains green at 141.59 KiB (32.08 KiB gzip), with no Node-only authentication dependency pulled through the edge-safe subpaths.
- The stable HTTP contract brings the focused kernel-plus-Hono matrix to 203 passing tests and the full repository to 1,948. The added matrix covers strict and structured-suffix JSON media types, malformed UTF-8/JSON, empty and oversized bodies, text and byte-exact binary output, header ownership, invalid representations, and failure-observer isolation.
- The 1,150-test coverage gate reports 92.07% statements, 86.48% branches, 91.45% functions, and 94.25% lines. The Hono adapter reports 96.82% statements, 94.44% branches, and 100% functions.
- The 47-test PostgreSQL integration suite (plus one intentional skip), 11-test parity suite, and 41-page documentation build pass the completed HTTP phase gate.
- The kernel/Hono edge bundle passes at 146.67 KiB (33.44 KiB gzip), and the dependency-clean packed consumer imports and runs the public subpaths from a 668-file, 649,848-byte archive.
- Executable transaction scopes bring the focused kernel/Hono/Drizzle matrix to 238 passing tests and the full repository to 1,983 passing tests.
- The real PostgreSQL integration suite passes 57 tests (plus one intentional skip), including operation-level commit, declared-failure rollback, five nested failure-injection points, caught joined-failure rollback, server-enforced read-only mode, and nested read-to-write escalation rejection.
- The 1,185-test coverage gate reports 92.26% statements, 87.04% branches, 91.74% functions, and 94.36% lines. The Drizzle unit-of-work implementation reports 100% statement, branch, and function coverage.
- The 11-test parity suite and 41-page documentation build remain green. The edge-safe kernel/Hono bundle remains free of the Node-only Drizzle adapter at 152.36 KiB (34.46 KiB gzip).
- The dependency-clean packed consumer imports the new `/drizzle` subpath from a 680-file, 658,129-byte archive.
- Typed repository primitives add 35 focused tests and bring the kernel/Hono/Drizzle matrix to 273 passing tests and the full repository to 2,018.
- The real PostgreSQL suite passes 60 tests (plus one intentional skip). Its repository fixture proves legacy-style audit names, closed summary/detail projections, active-row page/count agreement, soft delete/restore, and transaction-inherited rollback without concurrent queries on one client.
- The 1,220-test coverage gate reports 92.51% statements, 87.45% branches, 92.10% functions, and 94.57% lines. The complete Drizzle seam reports 99.46% statements, 99.26% branches, and 100% functions and lines.
- The 41-page documentation build remains green. The dependency-clean packed consumer executes the repository projection/pagination surface and verifies every new runtime export from a 700-file, 667,158-byte archive.
- Authorized tenant capabilities add 40 unit tests and bring the full repository to 2,058 passing tests. Compile-only contracts reject fabricated capabilities, missing scopes, scope/bypass substitution, numeric/string tenant-column mismatches, privileged methods on scoped-only factories, and privileged APIs on scoped repository results.
- The full PostgreSQL suite passes 63 tests (plus one intentional skip). The tenant fixture denies an unauthorized tenant before construction, then proves tenant-A reads, ID-based lookups, writes, and inserts cannot cross into tenant B. Separately typed privileged access updates tenant B only after recording both bypass issuance and repository use; an unavailable audit sink prevents construction.
- The 1,260-test coverage gate reports 92.67% statements, 87.83% branches, 92.10% functions, and 94.73% lines. The complete Drizzle seam reports 99.55% statements, 98.25% branches, and 100% functions and lines; the kernel reports 97.48%, 93.70%, 97.43%, and 98.09% respectively.
- The 11-test parity suite, 152.36 KiB edge dry run (34.46 KiB gzip), and 41-page docs build remain green. A dependency-clean consumer executes the public tenant authority, bypass, and repository-factory APIs from a 716-file, 677,175-byte archive.
- The isolated runtime audit reached the advisory service and identified one high-severity path from `@opentelemetry/sdk-node@0.218` to `@opentelemetry/propagator-jaeger@2.7.1`, opening a separate runtime dependency remediation before the database phase could close.
- The OpenTelemetry remediation removes every 0.218 SDK/exporter and 2.7 Jaeger package from the resolved graph. A real child-process probe boots `NodeSDK@0.222`, emits a span, and verifies that pino receives its active `trace_id` and `span_id`.
- The isolated 369-dependency production audit now passes with zero critical or high vulnerabilities; six moderate and one low advisory remain below the hard runtime threshold. This closes the database-phase security gate.
- The closing phase gate passes Biome, architecture lint, skills sync, TypeScript, build, 2,059 repository tests, 1,261 coverage tests, 63 live PostgreSQL tests (plus one intentional skip), 11 parity tests, the 152.36 KiB edge bundle (34.46 KiB gzip), and the 41-page documentation build. Coverage is 92.73% statements, 87.87% branches, 92.26% functions, and 94.76% lines; the dependency-clean packed consumer passes from a 716-file, 677,191-byte archive.
- Ten focused graph-tool tests cover deterministic TypeScript loading, graph emission, every inspect kind, transitive module/provider impact, diagnostic preservation, actual process exits 0/1/2, and the CLI entrypoint. The dependency-clean packed consumer runs all three commands against an installed TypeScript application declaration from a 719-file, 682,885-byte archive. Its 398-dependency production audit remains green with zero high or critical findings; the package-split gate owns moving the CLI-only TypeScript loader out of the runtime trust zone.
- The client-contract slice brings the full repository to 2,101 passing tests. Its 1,303-test coverage gate reports 92.95% statements, 88.79% branches, 93.40% functions, and 94.74% lines; the new contract seam reports 91.33%, 88.17%, 98.78%, and 92.43% respectively.
- Compile-only contracts prove exact operation IDs and input locations, success/error narrowing, explicit codec output types, rejection of non-HTTP operations, and a standalone published-contract shape with no Hono application type.
- The 63-test PostgreSQL/container integration suite (plus one intentional skip), 11-test parity suite, and 41-page docs build pass. The `/contract`-aware Cloudflare Worker dry run is green at 173.04 KiB (39.29 KiB gzip) without Node hashing or Zod projection in the bundle.
- A dependency-clean packed consumer imports every contract subpath, executes HTTP client/Hono parity, regenerates matching manifest/OpenAPI fingerprints through the installed CLI, and compiles exact call sites from a 754-file, 711,455-byte archive. The 398-dependency production audit remains at zero high or critical findings. The package-split gate retains both file count and runtime dependency count as reduction targets.
- The isolated `@sixthsummit/ship-core` package builds and passes 172 focused tests. Its production audit resolves only the package itself and reports zero vulnerabilities, while the full 2,101-test repository suite remains green through the compatibility export.
- The isolated `@sixthsummit/ship-hono` package builds, type-checks, and passes 64 focused tests. Its production closure is four dependency nodes with zero high/critical findings; the edge gate resolves the physical kernel/Hono packages rather than compatibility sources and remains green at 172.99 KiB (39.26 KiB gzip).
- The isolated `@sixthsummit/ship-testing` package builds, type-checks, and passes two focused parity-harness tests; the existing 11-test parity gate and 63-test real-PostgreSQL suite (plus one intentional skip) resolve the moved utilities successfully. Its separately audited 229-node tooling closure reports zero vulnerabilities.
- The isolated `@sixthsummit/ship-drizzle` package builds, type-checks, and passes 71 unit and compile-contract tests. The full 2,105-test repository suite, 63-test real-PostgreSQL suite (plus one intentional skip), and 11-test parity gate remain green; its four-node production closure reports zero vulnerabilities.
- The isolated `@sixthsummit/ship-contract` package builds, type-checks, and passes 26 runtime and compile-contract tests. Its four-node production closure reports zero vulnerabilities, and its 30-file archive keeps server projectors on explicit subpaths while the 172.98 KiB edge bundle proves the default client entry loads no Node hashing or Zod projection code.
- The isolated `@sixthsummit/ship-auth-firebase` package builds, type-checks, and passes 24 focused tests, including the real Hono wire statuses for missing, invalid, unknown, unavailable, and valid identities. Its six-file archive has a 177-node Firebase production closure with zero high or critical findings; six moderate and one low advisory remain below the hard runtime threshold.
- The isolated `@sixthsummit/ship-observability-otel` package builds, type-checks, and passes 37 focused SDK, trace-correlation, span, metrics, and shutdown tests. Its 18-file archive has a separately audited 172-node production closure with zero vulnerabilities.
- The explicit telemetry-bootstrap correction passes the generated template's
  standalone TypeScript check, 21 focused scaffold/SDK tests, repository
  Biome and architecture checks, all workspace type checks, and all 2,131
  repository tests. A static architecture test prevents the bootstrap from
  regaining HTTP or monolith imports before the dynamic server boundary.
- The isolated `@sixthsummit/ship-cli` package passes 24 focused tests across
  its programmatic API, standalone executable, and monolith compatibility
  path. Focused coverage is 92.71% statements, 81.09% branches, 92.42%
  functions, and 92.18% lines. The full repository passes 2,142 tests. Its
  22-file, 14,390-byte archive has a 35-node production closure with zero
  vulnerabilities.
- The clean installed-package gate passes for all 11 publishable workspaces:
  808 files and 657,463 archive bytes in total. It installs only generated
  tarballs into a temporary consumer, runs the physical kernel, Hono, Drizzle,
  contract, Firebase, telemetry, testing, CLI, and compatibility entrypoints,
  and compiles exact operation IDs plus public CLI diagnostics. Archive checks
  reject stale build state, tests, type-contract fixtures, and non-asset
  TypeScript source.
- The package-split phase closes with Biome and architecture checks, every
  workspace build and type check, 2,142 repository tests, 924 coverage tests,
  63 live container integration tests plus one intentional skip, 11 parity
  tests, the 172.98 KiB edge bundle (39.26 KiB gzip), the installed 11-package
  graph, and the 41-page documentation build green. Coverage is 90.15%
  statements, 83.90% branches, 88.10% functions, and 92.66% lines. The live
  405-dependency compatibility-runtime audit reports zero high or critical
  vulnerabilities; six moderate and one low finding remain below the hard
  threshold.
- The minimal golden consumer passes from five SHA-256-recorded package
  tarballs totaling 105,280 bytes, with no link back into the framework
  workspace. Its two unit tests and one PostgreSQL integration test cover
  permission denial, a protected read, a generated typed client, and a
  transaction-scoped insert/read round trip. Its isolated check, type-check,
  unit, build, and integration gates complete in about nine seconds on a warm
  local cache and Docker daemon.
- Nine new kernel tests cover effect token validation, immutable operation
  declarations, stable graph projection, undisclosed/unbound effects, hidden
  provider effects, and transactional false-atomicity rejection. All 2,151
  repository tests pass; the kernel remains at 96.93% statements, 93.03%
  branches, 95.18% functions, and 97.59% lines.
- Compile-only kernel contracts prove protected handlers can use `actor.id`
  directly while public handlers must still account for an anonymous request.
- Six focused migration-tool tests cover valid mappings, approved removals,
  missing/duplicate/unknown dispositions, duplicate legacy bindings, stale
  catalog identity, missing/non-HTTP targets, method/path drift, malformed
  documents, and the actual Commander surface. The 30-test CLI suite reports
  90.02% statements, 83.39% branches, 92.63% functions, and 89.70% lines; all
  2,157 repository tests pass.
- The installed 11-package graph executes `migrate-routes` from the packed CLI
  against a packed application at 812 files and 666,243 total archive bytes.
- The installed package graph calls a fake effect through the physical
  `@sixthsummit/ship-core` archive four times across direct, Hono, client, and
  parity execution and confirms the graph declaration. All 11 archives pass at
  808 files and 659,483 bytes; the isolated core archive remains 50 files and
  grows only to 43,646 bytes.
- The customized golden consumer passes from five SHA-256-recorded tarballs
  totaling 105,280 bytes with no workspace link. Three unit and three live
  PostgreSQL tests prove custom credentials, role and tenant policy denials,
  tenant-capability query isolation, filtered aggregate mapping, exact client
  types, graph-visible effects, and notification-adapter injection. Its
  isolated Biome, TypeScript, unit, build, and integration gates complete in
  about twelve seconds after the package build on a warm local cache and Docker
  daemon.
- Bounded request bodies bring the focused kernel, Hono, and contract suites to
  193, 79, and 32 passing tests. They cover recursively frozen policy metadata,
  auth-before-multipart ordering, streamed total limits, per-file/field/count
  limits, malformed framing, exact raw bytes, generated-client serialization,
  and OpenAPI media/limit projection.
- Focused coverage is 96.05% statements and 92.66% branches for the kernel,
  96.01% statements and 93.67% branches for Hono, and 88.16% statements and
  83.89% branches for the contract package.
- The completed request-body gate passes Biome, architecture lint, skills sync,
  every workspace build and type check, 2,193 repository tests, 924 coverage
  tests at 90.15% statements and 83.90% branches, 63 live container integration
  tests plus one intentional skip, and 11 parity tests. The edge bundle passes
  at 191.02 KiB (42.78 KiB gzip), the installed 11-package graph passes at 812
  files and 674,241 archive bytes, both packed golden consumers pass, the
  41-page docs build passes, and the 405-dependency runtime audit reports zero
  high or critical vulnerabilities.
