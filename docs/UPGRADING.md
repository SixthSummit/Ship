# Upgrading ShipAPI

Version-to-version upgrade notes for consumer apps already on a v4 line. Newest
first. Each entry covers **only what you have to change** — if a release isn't
listed, it had no consumer-facing migration. For the full v3 → v4 move, see
[MIGRATION_V3_TO_V4.md](./MIGRATION_V3_TO_V4.md).

---
## Kernel line — `createHonoAdapter({ cors })` (ship-hono minor, ship-cli minor)

**Who's affected:** kernel-line apps with a browser client on another origin.
Until now the adapter emitted no `Access-Control-*` headers and every app wired
`hono/cors` by hand (the Ship project template's `apps/api/src/http.ts`
workaround); compat-tier apps already had `createApp({ cors })`.

**What you change.**

- **Pass `cors` to the adapter** with the same object the compat tier takes:
  `createHonoAdapter(app, { cors: { origin: env.CORS_ORIGINS, credentials: true } })`.
  Preflights are answered for operation, streaming and webhook routes;
  `X-Request-Id`, `X-Ship-Cache` and every declared error header are exposed
  to the browser. Delete any hand-rolled `app.use("*", cors(...))` wrapper.
- **A wildcard origin with `credentials: true` now fails at boot**
  (`SHIP_HONO_CORS_INVALID`). List the origins explicitly.
- **An operation cannot set `Access-Control-*` headers through `respond()`**;
  they were never honoured consistently and are now reserved like
  `X-Request-Id`.
- **New scaffolds read `CORS_ORIGINS`** (comma-separated) in `src/http.ts`.
  Existing apps can copy that file.

---
## Kernel line — `hono`, `drizzle-orm` and `ioredis` become peer dependencies of the adapters (minor)

**Who's affected:** apps that install `@sixthsummit/ship-hono` without listing
`hono`, `@sixthsummit/ship-drizzle` or `@sixthsummit/ship-testing` without
listing `drizzle-orm`, or `@sixthsummit/ship-jobs-bullmq` /
`@sixthsummit/ship-realtime-socketio` without listing `ioredis`. The
`@sixthsummit/ship-api` compatibility distribution is unchanged.

**Why it changed.** Every app that mounts its own middleware imports Hono; every
app defines its schema with `drizzle-orm`; every app that runs jobs or the
realtime gateway constructs its own `ioredis` client. As regular dependencies of
the adapters those runtimes could resolve twice. It happened in the Ship project
template: a caret bump of the Ship packages pulled a newer `ship-hono` while the
app's exact `hono` pin stayed behind, two Hono type trees landed, and types
stopped lining up. The rule is recorded in
[VERSIONING.md](./VERSIONING.md#shared-runtimes-are-peer-dependencies).

**What you change.**

- **Add the runtime to your own `dependencies`** if you relied on the
  transitive copy: `hono` with the caret range `ship-hono` declares as its peer
  (`^4.13.13` today), `drizzle-orm` with `ship-drizzle`'s range, `ioredis` with
  the adapter's range. npm 7+ and pnpm install a missing peer automatically, so
  nothing breaks if you don't, but the app should own the version.
- **Never pin `hono` exactly next to caret Ship packages.** The scaffold now
  writes exact Ship pins and a caret `hono`; the pack and golden-consumer gates
  fail on a second copy.
- **If `npm install` reports `ERESOLVE` on `hono`**, your pin is outside the
  adapter's peer range. Move it into the range; don't pass `--legacy-peer-deps`.

---
## Kernel line — ship-core and ship-hono become peer dependencies of the adapters (minor)

**Who's affected:** apps that install any of `ship-hono`, `ship-drizzle`,
`ship-contract`, `ship-cli`, `ship-auth-firebase`, `ship-cache-redis`,
`ship-jobs-bullmq`, `ship-observability-otel`, `ship-realtime-socketio`,
`ship-testing` or `ship-webhooks` without listing `@sixthsummit/ship-core` (and,
for auth-firebase and realtime-socketio, `@sixthsummit/ship-hono`) themselves.
The `@sixthsummit/ship-api` compatibility distribution is unchanged.

**Why it changed.** These packages share ship-core's types, runtime guards and
registries with the app. As regular dependencies, a range that missed the app's
copy made npm install a private nested copy. In the 2026-10-04 dry run that
turned every authenticated request into a 500. As peers they always use the
app's copy, or `npm install` fails loudly.

**What you change.**

- **List `@sixthsummit/ship-core` and `@sixthsummit/ship-hono` as direct
  dependencies** if you don't already. Every known consumer does. npm 7+ and
  pnpm install a missing peer automatically, so nothing breaks if you don't, but
  the app should own the version.
- **If `npm install` now fails with `ERESOLVE`**, your `@sixthsummit/*` versions
  don't agree (for example a snapshot ship-core next to a stable adapter). Before
  this change you got a silent duplicate. Install all of them from the same
  release or snapshot run. Don't pass `--legacy-peer-deps` or `--force`.
- **Browser-only packages that depend only on `ship-contract`** are unaffected.
  Its ship-core peer is optional, and the browser entry points never import it.

---
## Kernel line — outbox claim indexes and the adaptive dispatch runner (`ship-drizzle` patch, `ship-core` minor)

**Who's affected:** every kernel-line app that stores an outbox with
`@sixthsummit/ship-drizzle`; apps that run `startRealtimePublicationRunner`
or their own dispatcher loop; code that pins the shape of an
`OutboxDispatchResult` or an outbox dispatcher's `describeOutboxOperation`
role.

**Why it changed.** The M10 capacity baseline
([ADR-0014 addendum](./rearchitecture/decisions/0014-actor-kinds-and-durable-outbox-delivery.md#addendum-2026-09-18-claim-cost-under-a-backlog-and-the-adaptive-dispatch-runner-sapi-114)):
the claim sorted every due row before `LIMIT`, so a 200k backlog cost 71 ms
per claim, and a fixed-interval dispatcher below the write rate grew the
backlog without bound.

**What you change.**

- **Generate a migration for the two new outbox indexes.** `shipOutboxTable()`
  now declares `<table>_pending_idx` (`outbox_id, available_at, created_at`
  `WHERE status = 'pending'`) and `<table>_lease_idx` (`outbox_id,
  lease_expires_at` `WHERE status = 'claimed'`). Run `drizzle-kit generate`
  against your schema; the migration is two `CREATE INDEX` statements and
  can run while dispatchers are live (use `CONCURRENTLY` by hand on a large
  table if your migration tool allows it). The claim uses them from the next
  deploy; without them it works but keeps the old cost.
- **Prefer the framework runner over a hand-rolled loop.**
  `startOutboxDispatchRunner(executor, "<outbox>.dispatch", { intervalMs,
  maxPassesPerCycle })` drains a full batch at once and idles on a short one;
  a loop that sleeps a fixed interval after every round has a capacity of
  `batchSize / interval`, which is what the baseline hit.
- **`startRealtimePublicationRunner` idles after a short batch.** A pass that
  claimed fewer records than the batch size now waits `intervalMs` (it used
  to pass again at once); a full batch still passes again immediately.
  Tests that timed passes may need the batch size or interval adjusted.
- **`OutboxDispatchResult` gains `batchSize`.** `toEqual` assertions on a
  dispatch result or on `describeOutboxOperation(dispatcher.dispatch)` (which
  gains `batchSize` and, when declared, `roundsPerSecond`) add the field;
  `toMatchObject` needs nothing.
- **Optional:** declare `expectedRatePerSecond` on the outbox and
  `roundsPerSecond` on its dispatcher so `ship-api check` warns
  `SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE` when the declared
  capacity is below the rate.

---
## Kernel line — realtime proof findings and replay path parameter (`ship-core` / `ship-contract` / `ship-testing` / `ship-realtime-socketio` minor)

**Who's affected:** kernel-line apps that implement `RealtimeBackend` or
`ApplicationExecutor` themselves, custom Socket.IO clients that call
`ship:presence.snapshot`, code that reads `ChannelGraphNode.payload`, and apps
that pass a `defineWebhookReplay` transport.

**Why it changed.** The realtime conformance improvements
([ADR-0017 addendum](./rearchitecture/decisions/0017-declared-realtime-publication.md#addendum-2026-09-18-realtime-refinements))
and its webhook re-run
([ADR-0018 addendum](./rearchitecture/decisions/0018-inbound-webhook-operations.md#addendum-2026-09-18-replay-path-parameter-name)).

**What you change.**

- **Custom realtime adapters implement `presence.actorOnline`.** The
  `RealtimePresence` interface gains the method; page `snapshot` through
  `pagePresenceMembers(members, request)` so `count`, `actorIds` and
  `nextCursor` match every other backend. `RealtimePresenceResult` gains the
  `page-invalid` reason. The conformance suite asserts both.
- **Snapshot consumers.** `RealtimePresenceSnapshot.actorIds` is now one page
  (default 100 members); read `count` for the membership size and follow
  `nextCursor` when present. On the wire the ack gains `nextCursor` and the
  error code `INVALID_PAGE`; the new `ship:presence.online` message answers
  `{ online }`.
- **Custom executors implement `tryRun`.** `ApplicationExecutor` gains
  `tryRun()`; wrap your `run()` with `operationExecutionFailure(error,
  requestId)` for a thrown `OperationExecutionError`. `createExecutor` users
  change nothing.
- **Channel graph nodes carry `payload.projectable`.** Tests that pin the
  whole node add it. Compilation now warns
  `SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE` for a payload the manifest cannot
  derive JSON Schema from; either declare it with Zod v4 or wrap it with
  `contractSchema()`. `ApplicationContractOf<typeof app>` gains `channels`.
- **Drop hand-written `contractSchema()` wrappers on Zod channel payloads.**
  Optional; the manifest derives the same JSON Schema from the schema.
- **Replay paths.** `/webhooks/:eventId/replay` keeps working. Any single
  `:name` segment now carries the event id (`input.params[name]`); pass
  `transport: { path, eventIdParameter }` to cross-check the name. A path
  that names another parameter was rejected before and is accepted now.
- **Legacy bridges.** Replace hand-built channel-to-token maps with
  `createChannelPublisherRegistry(app, backend)` or
  `defineRealtimePublicationModule(...).publishers`; hold
  `AnyChannelPublisher` where the channel is not known statically and
  `narrowChannelPublisher(publisher, channel)` where it is; call
  `executor.tryRun()` where a throw has nowhere to go; start
  `startRealtimePublicationRunner(executor)` in one process (or compose
  `defineRealtimePublicationDispatchJob` once you adopt jobs) so recorded
  publication intents are dispatched.

**What does NOT change.** `run()` semantics, the publication outbox path,
`defineChannel`'s arguments, the manifest shape for channels, and every
existing wire message.

---
## Kernel line — cache projection, scoped invalidation and job liveness (`ship-core` / `ship-hono` / `ship-contract` / `ship-cache-redis` / `ship-testing` / `ship-cli` minor)

**Who's affected:** kernel-line apps that declare `cache` or `invalidates`,
apps that mount `defineCacheInvalidationModule` or `defineJobManagement`, and
anything that reads `OperationGraphNode.invalidates` or compiled
`operation.invalidates`.

**Why it changed.** Two consumer proofs
([ADR-0019 addendum](./rearchitecture/decisions/0019-declared-read-cache.md#addendum-2026-09-18-cache-scoping-refinements),
[ADR-0015 addendum](./rearchitecture/decisions/0015-declared-jobs-and-schedules.md#addendum-2026-09-18-job-backend-refinements))
found that `scope: "public"` projected `Cache-Control: public` on
permission-gated reads, that tags purged every tenant and every actor, that the
backend token forced an artificial module, that framework modules add
permissions nobody documented, and that jobs could not say "collect now" or
report liveness.

**What you change.**

- **`Cache-Control` is `private` unless access is `publicAccess()`.** A
  `scope: "public"` read behind a permission now emits `private, max-age=N`,
  and the contract/OpenAPI constant follows. Clients that relied on
  intermediaries caching a protected read were relying on a leak; nothing to
  change unless a test pinned the old header. Compilation now warns
  `SHIP_CACHE_PUBLIC_SCOPE_PROTECTED` for that combination and fails
  `SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN` for `scope: "public"` with
  `optionalIdentityAccess()` — switch to `scope: "actor"` or public access.
- **`cacheControlHeader(cache)` → `cacheControlHeader(cache, access)`.** The
  second argument is optional; omitted, it projects `private`.
- **Scoped invalidation.** Where one tenant's (or one actor's) write should
  purge only its own entries, replace the plain tag with
  `{ tag, scope: "tenant", tenant }` or `{ tag, scope: "actor" }`. Plain
  strings keep purging every entry. Compiled `operation.invalidates` is now
  `readonly { tag, scope: "global" | "actor" | "tenant", tenant? }[]`; the
  graph keeps `invalidates: string[]` and adds `invalidatesScoped`. New
  diagnostics: `SHIP_CACHE_INVALIDATES_ACTOR_INVALID` (error),
  `SHIP_CACHE_TAG_SCOPE_UNMATCHED` (warning). The purge-intent payload gains an
  optional `scope`; a `ship-cache.invalidation` outbox written by the previous
  release still dispatches.
- **`vary(input, subject)`.** Existing one-argument `vary` functions keep
  working. A `scope: "public"` read whose `vary` names the subject warns
  `SHIP_CACHE_VARY_SUBJECT_PUBLIC`; declare `scope: "actor"` instead.
- **Let `ship-cache` own the backend token.** Pass
  `backend: cacheBackendDependency("…")` to `defineCacheInvalidationModule`
  and drop the `valueProvider(cacheToken, cache)` from your modules; they
  already import `ship-cache`. Optional.
- **Grant the framework permissions you mount.** `ship-cache` and every outbox
  dispatcher introduce `ship.outbox:manage`; `defineJobManagement` introduces
  `ship.jobs:manage`; `defineWebhookReplay` introduces `ship.webhooks:replay`.
  `ship-api inspect app` / `inspect module <id>` now lists them under
  `framework permissions`, and the kernel README carries the table. If your
  seed data asserts the full permission set, add them.
- **Jobs.** `retention: { completedMs: 0 }` is accepted (collect on the next
  sweep). `startJobRuntime` returns `runtime.liveness()`; mount
  `jobLivenessRoute({ runtime, staleAfterMs })` from `ship-hono` in the worker
  process instead of a hand-written heartbeat. Job ids and the
  `defineJobManagement` prefix are namespaced by the owning **module** id — the
  `SHIP_MODULE_OPERATION_ID_MISMATCH` hint now says so.

**What does NOT change.** Keys, hit/miss behaviour, the outbox path,
`CacheBackend`'s five methods, `x-ship-cache`, and the compatibility `Cache` /
`cached()` helpers.
## `@sixthsummit/ship-drizzle` 1.x → next minor — PostgreSQL job backend

**Who's affected:** kernel-line consumers that declare jobs but have no Redis
(or would provision Redis only for jobs). Nothing changes for applications
already on `@sixthsummit/ship-jobs-bullmq`.

**Why it changed.** ADR-0015 shipped one durable backend (BullMQ) and an
in-memory one whose run ledger dies with the process. Applications may use PostgreSQL without Redis, so
[ADR-0015's addendum](./rearchitecture/decisions/0015-declared-jobs-and-schedules.md#addendum-2026-09-18-postgresql-job-backend)
adds a PostgreSQL `JobBackend` next to the advisory lock provider that was
already in `@sixthsummit/ship-drizzle`.

**What you change.**

```ts
import { createDrizzleJobBackend, shipJobRunsTable, shipJobStateTable } from "@sixthsummit/ship-drizzle";

// schema.ts — include both tables in your migrations
export const jobRuns = shipJobRunsTable();
export const jobState = shipJobStateTable();

// composition
const backend = createDrizzleJobBackend({ database, table: jobRuns, stateTable: jobState });
providers: [
  valueProvider(jobBackendDependency(), backend),
  valueProvider(lockProviderDependency(), backend.lockProvider), // advisoryLockProvider(database) by default
]
const runtime = await startJobRuntime(app, { backend, mode: process.env.WORKER_MODE });
```

- Generate the migration from the two table exports (`drizzle-kit generate`);
  the backend never creates tables.
- Tune `pollIntervalMs` (default 1 s) to the latency you need; `enqueue` and
  `retry` in the worker process wake the loop immediately. `queueDepthLimit`
  (default 10 000) and `maxInFlight` (default 16) map to `concurrencyBudget`.
- Pass `onError` to log `SHIP_DRIZZLE_JOB_LEASE_STALE` and poll failures; they
  are absorbed by the worker loop, never thrown.
- Metrics use the same `ship.job.*` names and `ship.job.id` / `ship.job.key`
  attributes as the BullMQ adapter, so existing dashboards apply.
- `DrizzleRepositoryError` gains the codes `SHIP_DRIZZLE_JOB_BACKEND_INVALID`
  and `SHIP_DRIZZLE_JOB_LEASE_STALE` and optional `jobId` / `runId` fields.

**What does NOT change.** `defineJob`, `startJobRuntime`, the management and
cleanup operations and the BullMQ backend are untouched; both backends pass
`jobBackendConformance`, so switching is a change of two bound providers.

---
## Kernel line — webhook response modes and replay transport (`ship-core` / `ship-hono` / `ship-contract` minor)

**Who's affected:** applications on the operation kernel whose provider
executes the webhook acknowledgement (TwiML, bodiless status callbacks,
documents), and applications that hand-mounted `defineWebhookReplay` behind
their own route.

**What's new.** `defineWebhook` accepts `response: { mode: "json" } |
{ mode: "text", contentType } | { mode: "binary", contentType } |
{ mode: "empty" }` (ADR-0018 addendum). Text and binary handlers return the
body (`string` / `Uint8Array`) or `respond(status, body)`; `empty` handlers
return nothing and the adapter answers the declared success status with no
body and no content type. The graph, `x-ship-webhook` and OpenAPI document the
declared representation. `defineWebhookReplay` accepts
`transport: { path: "/webhooks/:eventId/replay" }` (or an `http.post(...)`
transport) so the replay mounts through `createHonoAdapter` under the same
permission gate; a `:eventId` path parameter or the JSON body carries the id.

**What you change.**

- Nothing for existing webhooks: the default stays `{ mode: "json" }` with the
  same JSON body and content type.
- Replace any middleware that rewrote a JSON acknowledgement into `text/xml`
  or an empty body with the declared mode, and drop the consumer output schema
  for `text`/`binary`/`empty` webhooks; it is framework-owned there.
- Replace a hand-mounted replay route with `transport` on
  `defineWebhookReplay`; direct `executor.run` callers pass `{ params: { eventId } }`
  when the path declares `:eventId` and `{ body: { eventId } }` otherwise.
- Regenerate client manifests if you mount replay: it is now an ordinary
  permission-gated operation in the contract.

**What does NOT change:** HTTP operations' representation rules
(`content-type` remains adapter-owned and reserved), every failure envelope,
verification order, idempotency and durable receipt. Webhooks stay outside the
streaming representation and the declared read cache: `response: { mode: "stream" }`
is `SHIP_WEBHOOK_RESPONSE_INVALID` and a `cache` declaration on `defineWebhook`
or `defineWebhookReplay` is `SHIP_WEBHOOK_CACHE_FORBIDDEN`.

---

## `@sixthsummit/ship-core` 1.1 → 1.2 — Jobs are declared operations

**Who's affected:** kernel-line consumers that schedule or enqueue background
work, and anything that inspects `ApplicationGraph` or `ApplicationDiagnostic`.

**Why it changed.** Background work now compiles into the application graph as
system-actor operations
([ADR-0015](./rearchitecture/decisions/0015-declared-jobs-and-schedules.md)),
so schedules, concurrency, retry, retention and job-to-job edges are visible
and enforced instead of living in a runtime registry.

**What you change.**

```ts
// Declare
const digest = defineJob({
  id: "reports.digest",
  input: z.object({ tenantId: z.string() }),
  trigger: { kind: "schedule", cron: "0 6 * * *", tz: "UTC" },
  concurrency: { mode: "single-runner", key: (input) => input.tenantId },
  retry: { attempts: 3, backoff: { initialMs: 1_000 } },
  transaction: "none",
  dependencies: {},
  handler: async ({ input, context }) => { /* context.actor.kind === "system" */ },
});

// Compose: bind a JobBackend and, for single-runners, a LockProvider
providers: [
  valueProvider(jobBackendDependency(), createBullmqJobBackend({ connection })),
  valueProvider(lockProviderDependency(), createRedisLockProvider({ client })),
]

// Run
const runtime = await startJobRuntime(app, { backend, mode: process.env.WORKER_MODE });
```

- `ApplicationGraph` gains `jobs`; `OperationGraphNode` gains an optional `job`
  projection; `DependencyGraphNode.scope` may be `"job"`.
- `ApplicationDiagnostic.severity` is now `"error" | "warning"`; `compileApp`
  throws only on errors and retains warnings on `app.diagnostics`
  (`ship-api check` prints them).
- `FrameworkOperationFailure` gains `JOB_LOCK_HELD` (409); it is only produced
  by job operations, which have no HTTP transport, so client contracts are
  unaffected.
- `defineApp` accepts `runtime: { workers: { mode, budget } }`.
- Schedule a single retention sweep with `defineJobCleanup({ trigger, outboxes })`
  instead of composing `defineOutboxCleanup` and scheduling it yourself
  (`defineOutboxCleanup` still works).

**What does NOT change.** Operations, outboxes, idempotency and the
compatibility `defineJob`/`JobsManager` in `@sixthsummit/ship-api` are
untouched; a parity test proves one handler yields the same result on both
paths.

---

## Kernel line — transactional realtime publication (`ship-core` / `ship-testing` minor, `ship-realtime-socketio` patch)

**Who's affected:** kernel-line apps that declare channels. Apps that publish
only from `transaction: "none"` operations change nothing unless they read
graph snapshots: every publishing operation node now carries
`publicationDelivery: "immediate" | "outbox"`. The client manifest is
unchanged.

**What's new.** A `transaction: "write"` operation may now declare
`publishes` ([ADR-0017 addendum](./rearchitecture/decisions/0017-declared-realtime-publication.md#addendum-2026-09-18-outbox-composition)).
Its bound `channel.publication` resolves to a publisher that validates scope
and payload exactly like the immediate path and records a publication intent
in the write transaction; the framework dispatcher publishes it after commit.

```ts
const request = defineOperation({
  id: "reports.request",
  transaction: "write",
  dependencies: { tx, requested: reportRequested.publication },
  publishes: [reportRequested],
  handler: async ({ services, context }) => {
    const recorded = await services.tx.reports.record(/* ... */);
    // Same call as on a transaction: "none" operation; dedupeKey is optional.
    await services.requested.publish(context.actor.id, { requestId: recorded.id }, {
      dedupeKey: recorded.id,
    });
    return { requestId: recorded.id };
  },
});

// Mount once. It provides channelPublisherProvider() for every listed channel,
// the outbox writer, `ship-realtime.publication.dispatch`, the dead-letter
// operations and `ship-realtime.publication.cleanup`.
const realtimeModule = defineRealtimePublicationModule({
  channels: [reportRequested, notificationDelivered],
  realtime: publisher,            // RealtimePublishBackend
  outbox: createDrizzleOutbox({ outbox: defineRealtimePublicationOutbox(channels), database, table }),
});

defineModule({ id: "reports", operations: [request], channels: [reportRequested],
  imports: ["ship-realtime"], providers: [/* no channelPublisherProvider here */], exports: [] });
```

**What you change.**

- Modules whose operations bind a listed channel's publication import
  `"ship-realtime"` and drop their own `channelPublisherProvider()` for that
  channel; the module provides it.
- Schedule `ship-realtime.publication.dispatch` and
  `ship-realtime.publication.cleanup` exactly as you schedule the cache
  invalidation dispatcher; both are `systemAccess()` operations.
- `SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN` is now reported only for
  `transaction: "read"` publishers. A write publisher whose application lacks
  the mounted module, or whose channel the module does not list, is the new
  `SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING`.
- `ChannelPublisher.publish` accepts an optional third argument
  `{ dedupeKey }`; immediate publication ignores it.
- Tests: `drainRealtimePublications(executor)` from `@sixthsummit/ship-testing`
  runs the dispatcher until idle so `collectPublishes()` observes durable
  publications.

**Guarantees to design for:** delivery is eventual (after commit plus
dispatcher lag) and at-least-once (a subscriber may receive one publication
twice). See [docs/v4/realtime.md](./v4/realtime.md#transactional-publication-outbox-composition-adr-0017-addendum).

---

## Kernel line — inbound webhook operations (`ship-core` / `ship-hono` / `ship-drizzle` / `ship-contract` / `ship-testing` minor, `ship-webhooks` 0.1.0-alpha.0)

**Who's affected:** applications on the operation kernel that receive
provider webhooks, and any application that already declared a raw-body
operation for that purpose.

**What's new.** `defineWebhook` ([ADR-0018](./rearchitecture/decisions/0018-inbound-webhook-operations.md))
declares a webhook as a bounded raw-body POST operation with
`providerAccess`, a bound verifier and secret source, executor-enforced
idempotency with an `inFlight` policy, and either an inline `handler` or
`receive: { mode: "enqueue" }` for durable receipt through the outbox.
Verifiers ship in the optional `@sixthsummit/ship-webhooks` package or can be
written in your repository against the kernel `WebhookVerifier` contract.

**What you change.**

- Pass `webhooks: { publicBaseUrl }` to `createHonoAdapter` when the app
  declares a webhook; the adapter refuses to start without it
  (`SHIP_HONO_WEBHOOK_BASE_URL_REQUIRED`) because URL-signing verifiers derive
  the canonical URL from it rather than from the request.
- Add `shipWebhookEventsTable()` to your migrations and bind
  `createDrizzleWebhookEventStore` when using enqueue mode.
- Replace hand-rolled raw-body operations that verify inside the handler with
  `defineWebhook`; the executor now also marks replayed idempotent results with
  `replayed: true` and reports `SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE`
  when a store call throws.
- `projectClientContract` no longer lists webhook operations and
  `ApplicationContractOf` omits them; regenerate client manifests. The manifest
  fingerprint of applications without webhooks is unchanged.

**What does NOT change:** every existing operation, the compat
`parseWebhook`/`idempotency()` helpers, and outbox/idempotency declarations.

---

## Kernel line — declared realtime channels (`ship-core` / `ship-contract` / `ship-testing` minor, `ship-realtime-socketio` 0.1.0-alpha.0)

**Who's affected:** kernel-line apps only. Nothing changes unless you adopt
channels, with two exceptions: `defineModule()` results now carry a `channels`
array (empty by default), the application graph carries `channels` and each
operation node carries `publishes`, and the client manifest carries
`channels` and `operations[].publishes`. Graph or manifest snapshots need
regenerating; hand-written manifests stay valid because both fields are
optional on input.

**What you can now declare.**

```ts
const activity = defineChannel({
  id: "reports.delivered",
  scope: "actor",                 // "actor" | "tenant" | "resource"
  payload: deliveredSchema,       // any Standard Schema
  presence: false,
});

const notify = defineOperation({
  // ...
  transaction: "none",            // publishes are immediate effects (ADR-0010)
  dependencies: { delivered: activity.publication },
  publishes: [activity],
  handler: async ({ services, context }) => {
    await services.delivered.publish(context.actor.id, { /* payload */ });
  },
});

defineModule({ id: "reports", operations: [notify], channels: [activity], providers: [
  channelPublisherProvider(activity, realtimeBackend),
], imports: [], exports: [] });
```

- `resource` channels must declare `authorizeSubscription(actor, resourceRef, ctx)`.
- `tenant` channels are published with an authentic `TenantScope`, never a raw id.
- Publishing from a `read`/`write` operation was
  `SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN` in this release; the
  transactional path landed in the entry above.

**Tests.** `collectPublishes(app)` from `@sixthsummit/ship-testing` recompiles
the app onto a recording backend; `createInMemoryRealtimeBackend()` is the
process-local backend for unit and smoke tests.

**Serving subscribers.** Add `@sixthsummit/ship-realtime-socketio`:
`createRealtimePublisher({ redis })` in the API process binds channel
publications; `createRealtimeGateway({ channels: app, auth, redis, tenantScopes })`
runs the Socket.IO gateway (same process or its own). The wire protocol is
[docs/v4/realtime.md](./v4/realtime.md).

---

## `@sixthsummit/ship-core` 1.1 → 1.2 — Declared read caching

**Who's affected:** kernel-line consumers that cache reads today with the
compatibility `cached(cache, key, ttl, fn)` helper, and anyone adopting the new
`cache` declaration. Nothing breaks: `cached()`, `Cache`, `InMemoryCache` and
`RedisCache` are untouched, and an operation without a `cache` declaration
behaves exactly as before.

**Why it changed.** With `cached()` the consumer writes the key, and every
real failure mode came from a key missing a dimension — most seriously the
tenant, which turns a cache hit into a cross-tenant disclosure. Caching is now
declared on the operation and the framework derives the key
([ADR-0019](./rearchitecture/decisions/0019-declared-read-cache.md)).

**What you change.**

```ts
// BEFORE — the key is yours, and so is every dimension you forget
const rows = await cached(cache, `portfolio:${tenantId}`, 30, () => load(tenantId));

// AFTER — declare the policy; the executor derives the key
const cacheToken = cacheBackendDependency("platform.cache");

defineOperation({
  id: "portfolio.summary",
  transaction: "read",            // "none" or "read" only
  dependencies: { tx, cache: cacheToken },
  cache: {
    ttlMs: 30_000,
    scope: "tenant",              // "actor" | "tenant" | "public"
    tags: ["portfolio.summary"],
    // Must return an authentic TenantScope from your own authority.
    tenant: ({ input, context }) => tenants.issue({
      tenantId: input.params.tenantId,
      requestId: context.requestId,
      actor: context.actor,
    }),
  },
  handler: /* … */,
});

// A write names the tags it invalidates; the executor records a durable purge
// intent inside the write transaction.
defineOperation({
  id: "portfolio.record",
  transaction: "write",
  invalidates: ["portfolio.summary"],
  handler: /* … */,
});
```

**Mount the invalidation module once**, or compilation fails with
`SHIP_CACHE_INVALIDATION_DISPATCHER_MISSING`, and add `"ship-cache"` to the
imports of every module containing an invalidating write:

```ts
import { createRedisCacheBackend } from "@sixthsummit/ship-cache-redis";

const cache = createRedisCacheBackend({ client: redis, keyPrefix: "billing:4.0.0:" });
const invalidation = defineCacheInvalidationModule({
  cache,
  outbox: createDrizzleOutbox({ outbox: cacheInvalidationOutbox, database, table }),
});
```

Schedule `ship-cache.invalidation.dispatch` on your job runner exactly as you
schedule any other outbox dispatcher, and `ship-cache.invalidation.cleanup` for
retention.

**Invalidation is eventual.** Between the write committing and the dispatcher
running, a cached read can still return the pre-write value. The window is
bounded by dispatch frequency and by `ttlMs`; the emitted `Cache-Control`
(`private, max-age=…` for actor and tenant scope, `public, max-age=…` for public)
is the staleness a caller accepts, not a freshness promise. Do not cache a read
that cannot tolerate it.

**What does NOT change.** Declared failures are never cached. `x-ship-cache` is
a reserved response header. A write operation may not declare `cache`
(`SHIP_CACHE_TRANSACTION_FORBIDDEN`), and `invalidates` requires
`transaction: "write"` (`SHIP_CACHE_INVALIDATES_TRANSACTION_INVALID`) because an
intent outside a transaction cannot commit with the change it describes.
---

## `@sixthsummit/ship-core` 1.0 → 1.1 — Actors declare a kind

**Who's affected:** kernel-line consumers that construct `OperationActor`
values as plain object literals (`{ id, permissions }`) in actor resolvers,
tests, or direct `executor.run(..., { actor })` calls. Anything that already
goes through `operationActor()` keeps working.

**Why it changed.** Outbox dispatchers, job runners and verified provider
callbacks now run through the executor as their own actor kinds
([ADR-0014](./rearchitecture/decisions/0014-actor-kinds-and-durable-outbox-delivery.md)).
`OperationActor.kind` is required so `systemAccess()` / `providerAccess(id)`
can be enforced and projected, and so a raw snapshot can never be mistaken for
a privileged one.

**What you change.**

```ts
// BEFORE — raw literal accepted by the executor and isOperationActor()
{ ok: true, actor: { id: account.id, permissions } }

// AFTER — either name the kind or use the constructor (defaults to human)
{ ok: true, actor: operationActor({ id: account.id, permissions }) }
// or, for framework-driven work
systemActor({ id: "reports.dispatcher", onBehalfOf: { actorId: account.id } })
providerActor({ id: event.id, provider: "stripe.webhooks" }) // after verification
```

**What does NOT change.** `authenticatedAccess()` and `permission(...)` accept
every kind; system actors get no implicit permissions and still need tenant
authorization. `ClientContractAccess` gains `system` and `provider` variants
and typed client results gain the `IDEMPOTENT_IN_FLIGHT` (409) framework
failure; existing narrowing on other codes is unaffected.
## Operation kernel — declared streaming responses (`@sixthsummit/ship-core` 1.1, `@sixthsummit/ship-hono` 1.1, `@sixthsummit/ship-contract` 1.2)

**Who's affected:** kernel consumers only. Nothing changes for existing unary
operations; the compatibility `streamSSE`/`streamLLM` helpers are untouched.

**What's new.** An HTTP transport may declare
`response: { mode: "stream", framing: "sse", frame, heartbeatMs, maxDurationMs, maxFrames }`.
The handler receives `stream.emit(frame)` and `stream.signal`, returns the
operation's `200` output as the terminal value, and must be `transaction: "none"`.
`compileApp` reports `SHIP_OPERATION_STREAM_*` diagnostics for missing limits,
transactional streams, an idempotency or `cache` declaration (streams bypass the
declared read cache), or an output map other than `{ 200 }`. The adapter serves `200 text/event-stream`, and the structural
client's `call()` returns a stream handle instead of a promise for those
operations. See [docs/v4/streaming.md](./v4/streaming.md) for the wire and
manifest contract and the `MIGRATION_V3_TO_V4.md` "Streaming" section.

**Additive type changes to check.** `HttpResponseMode` now includes `"stream"`;
`HttpTransport` is a type alias with an optional `response` member;
`OperationHandlerArguments` gained a fourth type parameter;
`ClientContractOperation` gained an optional `response`; and
`OperationClient.call()` returns `OperationCallResult<TOperation>` (a promise for
unary operations, `OperationStreamHandle` for streams). Code that exhaustively
switches on `metadata.response` must handle `"stream"`.

**Direct execution of a streaming operation** requires a sink:
`executor.run(id, input, { stream: { write(frame) {} } })`.

---

## 4.0.0-alpha.4 → 4.0.0-alpha.5 — Mount module sub-apps at the root

**Who's affected:** any app whose `src/index.ts` threads one shared app through
several `defineXxxRoutes(app, deps)` calls (the earlier alpha composition). If
you wire only one module today you won't hit a wall yet, but adopt the new shape
now — the old pattern stops compiling once you have enough modules.

**Why it changed.** Chaining every module's routes onto a single Hono app
accumulates one giant route-type. Past a threshold (sooner with auth/validation-
heavy routes) `tsc` overflows — `TS2589: Type instantiation is excessively deep`,
or a hard `RangeError` in the type checker — and the emitted types degrade so the
`hc()` client collapses to `never` on consumers, breaking *unrelated* endpoints.
Composing each module as its own bounded sub-app keeps each route-type
instantiation bounded, so the typed client scales ~4× further.

**What you change — `src/index.ts` only.**

```ts
// BEFORE — one app threaded through every module (the foot-gun)
const app = createApp({ cors });
registerErrorHandlers(app);
app.use("*", httpLogger());
const a = defineAccountsRoutes(app, { service: accountService, provider });
const b = defineOAuthRoutes(a, { service: oauthService, provider, /* … */ });
export type ShipApiClient = typeof b;
```

```ts
// AFTER — each module is its own sub-app, mounted at the root
import { buildAccountsApp } from "./modules/accounts/index.js";
import { buildOAuthApp } from "./modules/oauth/index.js";

const root = createApp({ cors });
registerErrorHandlers(root);          // root owns cross-cutting concerns
root.use("*", httpLogger());

const app = root
  .route("/", buildAccountsApp({ service: accountService, provider }))
  .route("/", buildOAuthApp({ service: oauthService, provider /* … */ }));
export type ShipApiClient = typeof app;
```

**What does NOT change** — this is a composition-only change:

- Your routes, handlers, and **absolute paths** (`/accounts`, `/accounts/:id`) —
  modules mount at `/`, so nothing about the URLs moves.
- The **`hc()` client shape**: `api.accounts.$get()` is byte-for-byte identical.
  No client-side code changes, no codegen.
- The **route registry** / `/dev/routes` / MCP `execute_route` — paths are
  recorded exactly as before (and now also carry the owning module name).

**One rule to follow.** Keep `registerErrorHandlers`, `httpLogger`, and CORS on
the **root only**. A module sub-app must never set its own `onError` (it would
shadow the uniform AppError JSON shape) or `use("*")` (request-context logging
must wrap every sub-app from the root).

**Module authors.** Each module now exposes `buildXxxApp(deps)` — a one-liner
returning `defineXxxRoutes(createModuleApp("xxx"), deps)`. `ship-api g module`
and `g resource` scaffold it for you. `defineXxxRoutes(app, deps)` is still
exported for advanced composition, but is flagged as a scaling foot-gun.

**Optional, while you're here (all independent of the above):**

- **Pin one hono version** across your workspace (`overrides` / a single hoisted
  copy). Duplicate or skewed hono copies are themselves a TS2589 trigger.
- **Cross-package consumers** (a separate web/mobile package importing your API's
  types): set `declaration: true` in the API package's `tsconfig` and export a
  materialized client (`src/client.ts` with `Client = ReturnType<typeof hc<…>>`
  + an `hcWithType` wrapper). Consumers import the flattened built type instead
  of re-deriving the whole route chain — measurably faster editor type-checking.
  New apps scaffolded from the template already include this.
- **`ShipApiSuccessClient<App>`** (from `@sixthsummit/ship-api/client`) narrows
  the client to success-status (`200 | 201`) responses — handy when errors are
  handled centrally (the default, via `registerErrorHandlers` + the typed
  client's `fetch`).
