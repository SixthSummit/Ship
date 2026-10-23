# Migrating v2/v3 applications to the v4 operation kernel

The v4 target is not a mechanical Express-to-Hono and TypeORM-to-Drizzle rewrite.
It is an incremental replacement of implicit framework behavior with explicit,
executable operations. Current v4 route-first APIs remain available as a
compatibility distribution while applications move one bounded slice at a time.

> **Release status:** stable kernel and compatibility releases are available.
> Migrations must consume exact released versions, prove application behavior
> in a no-traffic preview, and preserve a working rollback. Framework publication
> does not authorize an application production rollout.

## What the redesign removes

Each migrated operation declares in one place:

- stable identity;
- input and status-indexed output schemas;
- expected errors;
- access policy;
- transaction mode;
- dependencies and external effects; and
- optional HTTP transport and body/representation policy.

That one graph drives direct execution, Hono, the client manifest, OpenAPI,
inspection, impact analysis, and route-migration accounting. A migration no
longer needs to recreate a controller decorator, base service, route registry,
frontend DTO, MCP metadata, and prompt convention separately.

## What it does not remove

The framework cannot decide or automate application truth:

- physical database names, constraints, data meaning, or safe migrations;
- authentication-age, unknown-account, and permission business rules;
- money, credits, billing, destructive retention, or external-effect semantics;
- deployment topology, secrets, package access, traffic, and rollback; or
- frontend resource behavior and production acceptance.

Treat those as consumer-owned gates. A cleaner framework reduces translation and
drift; it does not waive data or operational proof.

## Migration strategy

Use parallel, permanent vertical slices. Keep the current application deployable,
build an operation implementation on a protected migration branch, and preview
the replacement without traffic before switching a route cohort.

Do not combine broad framework upgrades, schema reinterpretation, frontend
rewrites, and production cut-over in one change.

## 0. Freeze a trustworthy baseline

Before new framework code:

1. pin the current route catalog and candidate revision;
2. run the unchanged lint, TypeScript, build, unit, integration, and route-ledger
   gates;
3. record current HTTP status/body/header behavior for the slice;
4. capture physical PostgreSQL schema evidence where data is involved; and
5. prove the current deploy and rollback path.

Old tests are not automatically discarded. Keep tests that describe supported
behavior. Replace tests that only mock an obsolete framework layer when the same
behavior is covered more directly through the operation executor, Hono adapter,
or real disposable infrastructure. Untouched compatibility code keeps its old
suite until it is removed.

## 1. Account for every route exactly once

Create a stable JSON catalog from the current application. Each method/path gets
one immutable route ID. Then create a migration mapping in which every catalog
entry has exactly one disposition:

- mapped to one compiled HTTP operation with the same method/path; or
- deliberately removed with a decision ID and reason.

Run:

```sh
ship-api migrate-routes \
  --app ship.config.ts \
  --catalog .ship/legacy-routes.json \
  --mapping .ship/route-mapping.json \
  --format json
```

The command fails on a stale revision, missing or duplicate disposition, unknown
operation, non-HTTP operation, and method/path drift. It turns “we think we moved
everything” into an executable completeness gate.

Route counts are a baseline, not a permanent number. Additions and removals update
the catalog through a reviewed delta; they never disappear silently.

## 2. Consume one exact release set

The focused packages version independently. Install the exact versions from the
reviewed release manifest; do not use workspace links, broad ranges, or a locally
packed artifact for a shared preview.

Typical packages are:

```text
@sixthsummit/ship-core
@sixthsummit/ship-hono
@sixthsummit/ship-contract
@sixthsummit/ship-drizzle          when PostgreSQL is needed
@sixthsummit/ship-auth-firebase    when Firebase is used
@sixthsummit/ship-observability-otel when OTel is used
@sixthsummit/ship-testing          development only
@sixthsummit/ship-cli              development only
```

Prove installation in clean CI and the real deployment build environment. Record
the source SHA, package versions, archive integrity, lockfile, and registry
identity. The scaffold release manifest and packed-package gate prove framework
coherence; the consumer still proves access and installation.

## 3. Build one bounded module

Start with a low-risk read or small CRUD slice. Model the current wire contract,
not an imagined cleaner response.

```ts
const readAccount = defineOperation({
  id: "accounts.read",
  transport: http.get("/v1/accounts/:accountId"),
  input: { params: accountParams },
  output: { 200: accountView },
  successStatus: 200,
  errors: [accountNotFound],
  access: permission("accounts.read"),
  transaction: "read",
  dependencies: { tx: accountsUnitOfWork },
  handler: async ({ input, services }) => {
    const account = await services.tx.accounts.find(input.params.accountId);
    if (!account) throw operationFailure(accountNotFound);
    return toAccountView(account);
  },
});
```

Keep response mapping explicit. Repository rows and server-only types must not
become the client contract by accident.

For each slice, test:

- direct success and expected failures;
- anonymous, invalid, forbidden, and allowed access as applicable;
- Hono method/path/input/status/body/header parity;
- transaction commit and rollback;
- real PostgreSQL queries where query or schema behavior matters; and
- route mapping completeness.

## 4. Preserve authentication and permissions

Credential extraction, identity verification, account resolution, and access are
different responsibilities:

```text
HTTP credential -> verified identity -> application actor -> operation access
```

Preserve the current application's actual rules, including:

- ordinary versus forwarded authorization-header order;
- optional missing credentials versus invalid present credentials;
- token age/cutoff and revocation behavior;
- unknown verified identities;
- role plus direct grants;
- exact permission slugs; and
- security-event persistence/redaction.

Use `@sixthsummit/ship-auth-firebase` only for reusable Firebase verification.
Keep application-specific account and permission lookup in the consumer. The
kernel enforces the same access declaration for direct and HTTP execution.

### Framework permissions

Some framework modules generate operations gated by permission slugs of their
own. They are ordinary `permission()` declarations, so your authorization
model must know them before the operations can be reached — a seed-data test
that asserts the full permission set will fail the first time you mount one.

| Slug                   | Introduced by                                                                                                              | Gates                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ship.outbox:manage`   | every `defineOutboxDispatcher` with `deadLetter: true`, including `defineCacheInvalidationModule` and `defineRealtimePublicationModule` | `<outbox>.list-failed`, `<outbox>.retry`, `<outbox>.discard` |
| `ship.jobs:manage`     | `defineJobManagement`                                                                                                      | `<prefix>.list-failed`, `.retry`, `.discard`, `.health`       |
| `ship.webhooks:replay` | `defineWebhookReplay`                                                                                                      | the generated replay operation                                |

Declared caching adds no slug of its own; mounting `ship-cache` brings
`ship.outbox:manage`. The slugs are colon-separated; if your slug grammar
differs, translate once in your actor resolver rather than renaming the
operations. `ship-api inspect app` and `ship-api inspect module <id>` list the
permissions each module demands, framework-introduced ones under
`framework permissions`.

## 5. Map the physical database exactly

PostgreSQL is authoritative. Do not infer table, column, enum, index, constraint,
relation, default, or audit-field names from TypeORM classes or Ship conventions.

The legacy `migrate-orm` command can produce a translation/TODO inventory. Its
output is not executable schema truth and must not be applied to production
without independent catalog comparison.

For every data-backed slice:

1. obtain an approved schema-only or sanitized production-shaped source;
2. define exact Drizzle mappings without renaming physical objects;
3. compare tables, columns, types, enums, defaults, constraints, indexes, and
   foreign keys;
4. prove representative reads and writes against disposable PostgreSQL;
5. run mutations through the declared unit of work;
6. inject failures between statements and prove rollback; and
7. fingerprint relevant rows before and after any baseline operation.

Never treat an empty generated diff alone as data-safety evidence.

Once the Drizzle mappings exist, put the generated migrations under
`@sixthsummit/ship-schema-lint` ([schema safety](./v4/features/schema-safety.md)):
`ship-schema-lint check` refuses column drops, renames, retypes, NOT NULL
without a default, non-concurrent indexes and backfills inside DDL and prints
the safe recipe; `ship-schema-lint release` is the gated release step that
replaces boot-time `migrate()`; the committed `schema.snapshot.json` fails CI
when the physical schema drifts. Set `baseline` to the last historical
migration so the linter starts with the first migration you write on v4.

## 6. Make effects visible

A write operation may update the database in one unit of work. Email, webhooks,
queues, storage, and provider calls are external effects and need explicit
delivery semantics.

Immediate effects are rejected inside database transactions. For durable work,
write an outbox/receipt record in the same transaction and dispatch it
separately. Prove idempotency, retry, crash recovery, and single ownership with
failure injection. Webhook signature verification and byte limits happen before
business handling.

### Webhooks

Port a v3 webhook route to `defineWebhook` rather than to a hand-written
raw-body operation. The declaration carries the provider verifier and secret
source, the byte limit and media types, the idempotency window and in-flight
policy, and either an inline handler or `receive: { mode: "enqueue" }`, which
commits the exact bytes and one outbox intent before acknowledging. The Hono
adapter verifies before any actor exists and derives URL-signed schemes'
canonical URL from `webhooks.publicBaseUrl`, so a v3 route that trusted the
incoming `Host` needs the public URL declared once instead. Provider verifiers
for Stripe, GitHub, Slack, Twilio, Resend, HighLevel and a shared-secret
fallback live in `@sixthsummit/ship-webhooks`; a provider not listed there is a
consumer-owned verifier of the same kernel contract. Compat
`parseWebhook` + `idempotency()` routes keep working during the overlap; the
parity suite shows the one behavioural change: a duplicate is replayed only
after its signature verifies.

A v3 route that answered something other than JSON keeps that wire form by
declaring it: `response: { mode: "text", contentType: "text/xml" }` for TwiML
or any document the provider executes (the handler returns the string),
`response: { mode: "binary", contentType }` for bytes, and
`response: { mode: "empty" }` for status callbacks that expect a bodiless
`200`. Failures stay the JSON envelope in every mode. A v3 `POST
/webhooks/:id/retry` debugging route becomes `defineWebhookReplay({ ...,
transport: { path: "/webhooks/:eventId/replay" } })`, mounted by the adapter
and gated by `ship.webhooks:replay` (or the permission you declare) instead of
a hand-written handler around the executor.

## 6a. Caching

v3 caching is a call inside a handler: `cached(cache, key, ttl, fn)` with a
consumer-written key, and `cache.invalidateTag(tag)` wherever the author
remembered. Both stay supported through the migration window, and both keep
their failure modes — a key that omits the tenant serves one tenant's read to
another, and a purge issued in a handler is lost if the process dies or the
surrounding transaction rolls back.

Port a cached read to a declaration on the operation:

```ts
cache: {
  ttlMs: 30_000,
  scope: "tenant",                 // or "actor" / "public"
  tags: ["portfolio.summary"],
  tenant: ({ input, context }) => tenants.issue({ /* your authority */ }),
}
```

The executor derives the key from the operation id, its graph version, the scope
key, the canonical validated input and any `vary` values, so the dimensions you
used to hand-assemble are no longer yours to forget. Only `transaction: "none"`
and `transaction: "read"` operations may declare a cache. `vary` receives the
validated input and a read-only `{ actor, context }` subject; if a
`scope: "public"` read's key needs the actor, it is actor-scoped — declare
`scope: "actor"` (the compiler warns `SHIP_CACHE_VARY_SUBJECT_PUBLIC`).

**`scope` names the key, not the HTTP cacheability.** `scope: "public"` means
every caller allowed in shares one entry; the projected `Cache-Control` is
`public` only when the operation's access is `publicAccess()`, and `private`
otherwise, so an intermediary never stores a permission-gated body. A shared
key behind a permission compiles with the `SHIP_CACHE_PUBLIC_SCOPE_PROTECTED`
warning — confirm the body has no per-caller dimension — and a shared key on an
`optionalIdentityAccess()` read is rejected (`SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN`).

Port each `invalidateTag` call to `invalidates` on the `transaction: "write"`
operation that causes the change. The purge becomes a durable intent recorded in
that transaction and performed afterwards by the `ship-cache.invalidation`
dispatcher, which you mount once with `defineCacheInvalidationModule` and
schedule like any other outbox dispatcher. Match the purge to the read's scope:

```ts
invalidates: [
  "catalogue.lessons",                                          // every entry under the tag
  { tag: "inbox", scope: "actor" },                             // only the writing actor's entries
  { tag: "team.roster", scope: "tenant", tenant: tenantOf },    // only the derived tenant's entries
]
```

A plain tag purges every tenant's and every actor's entries — correct, but with
thousands of tenants one write becomes a stampede. The scoped forms purge only
the entries a read of the same scope stored for that subject; `tenant` has the
same contract as `cache.tenant` and must return an authentic `TenantScope`.

Bind the backend once: pass `backend: cacheBackendDependency("platform.cache")`
to `defineCacheInvalidationModule` and let every module with a cached read
import `ship-cache` instead of inventing a module to own the token. Mounting
`ship-cache` introduces `ship.outbox:manage` (see *Framework permissions*).

Two things to carry into your migration checks:

- **Invalidation is eventual.** A read between commit and dispatch may still
  return the pre-write value. Bound it with dispatch frequency and `ttlMs`, and
  do not cache a read that cannot tolerate the window.
- **Verify the isolation you assumed.** Point the migrated read at two tenants
  with identical input and confirm two distinct payloads. If the v3 key was
  wrong, this is where you find out.

Backends: `@sixthsummit/ship-cache-redis` for production,
`createInMemoryCacheBackend` from `@sixthsummit/ship-testing` for tests and
single-process development. Both pass the same `cacheBackendConformance` suite,
so an adapter you write yourself can prove the same contract.

See [ADR-0019](rearchitecture/decisions/0019-declared-read-cache.md) and
[UPGRADING.md](UPGRADING.md).

## 6a. Realtime

Compatibility Socket.IO rooms named after domain records have no schema,
policy, or graph presence. On the kernel line, declare a channel per
publication (`defineChannel`) with an `actor`, `tenant`, or `resource` scope,
own it in a module, and publish only from `transaction: "none"` operations
through the channel's publication token. Subscribers authenticate through the
same credential adapter and actor resolver the HTTP adapter uses; tenant
subscriptions are authorized by your `TenantScopeAuthority`, resource
subscriptions by the channel's own policy. Serve subscribers with
`@sixthsummit/ship-realtime-socketio` (API-side publisher, separate or
co-located gateway over Redis); the client contract lists channels and each
operation's `publishes` so frontends type their subscriptions. Transactional
publishes wait for the outbox composition (ADR-0017 §9). Wire protocol:
[docs/v4/realtime.md](./v4/realtime.md).

## Workers and scheduled jobs

v3 cron entries and ad-hoc queue consumers become declared jobs. Each job names
its trigger (`schedule` with an IANA `tz`, `interval`, `enqueue`, or an
authenticated `http` trigger), its concurrency (`single-runner` is per key,
never per queue, and a keyless single-runner must justify itself with
`reason`), its bounded `retry`, its `transaction` mode and its `retention`.

Jobs run as `system` actors with no permissions. Re-authorize the tenant inside
the handler through your own tenant policy; never serialize a tenant grant into
the job input. A job that writes to the database records its outbox intent in
the same transaction and lets the dispatcher perform the effect; the compiler
rejects an immediate effect on a transactional job.

Compose one `JobBackend` and one `LockProvider` as singleton providers, add
`defineJobManagement()` and `defineJobCleanup({ trigger, outboxes })`, and
start the process with `startJobRuntime(app, { backend, mode })` where `mode`
is `api`, `worker` or `all`. Two durable backends pass the same conformance
suite; pick by what your deployment already runs:

| Backend | Choose when | Trade-off |
| --- | --- | --- |
| `createBullmqJobBackend` (`@sixthsummit/ship-jobs-bullmq`) + `createRedisLockProvider` | Redis is already part of the deployment | Push-based workers, stalled runs recovered by the queue, lock keys expire server-side |
| `createDrizzleJobBackend` (`@sixthsummit/ship-drizzle`) + `backend.lockProvider` (`advisoryLockProvider`) | PostgreSQL is the only stateful dependency (App Engine + Cloud SQL, no Memorystore) | Polling (`pollIntervalMs`, default 1 s), one short transaction per claim and per outcome, `shipJobRunsTable()` / `shipJobStateTable()` in your migrations, and the advisory-lock lease note in the package README |

A v3 `defineCron` becomes a `schedule` or `interval` trigger on either backend;
a v3 BullMQ `defineJob` maps naturally onto the BullMQ backend, but nothing in
the job declaration depends on the backend, so an application can start on
PostgreSQL and move to Redis (or back) by changing the two bound providers. Prove single ownership with two worker processes, crash recovery at
Job ids are namespaced by the module that owns them, exactly like every other
operation id: a job `example-jobs.process-record` lives in a module whose id
is `example-jobs`, and `defineJobManagement({ prefix })` takes the id of the
module you spread its operations into, not an application name. `retention`
accepts `0` for "collect on the next cleanup sweep".

Compose one `JobBackend` (`@sixthsummit/ship-jobs-bullmq`) and one
`LockProvider` (Redis or `advisoryLockProvider` from `@sixthsummit/ship-drizzle`)
as singleton providers, add `defineJobManagement()` (introduces
`ship.jobs:manage`, see *Framework permissions*) and
`defineJobCleanup({ trigger, outboxes })`, and start the process with
`startJobRuntime(app, { backend, mode })` where `mode` is `api`, `worker` or
`all`. Replace a hand-written worker heartbeat with the runtime's own
liveness: `runtime.liveness()` reports each job's last start, completion,
failure and the lag since its last success, and
`jobLivenessRoute({ runtime, staleAfterMs })` from `@sixthsummit/ship-hono`
serves it as `200`/`503` in the worker process. Prove single ownership with two worker processes, crash recovery at
"before commit", "after commit" and "after external success", and backpressure
(`queue-full`) with a burst — the framework's own integration lane shows the
shape.

## 7. Prove representative patterns before scaling

Do not port hundreds of routes to discover an architectural gap late. A useful
representative suite covers:

| Pattern | What it proves |
| --- | --- |
| Protected read | credential, actor, permission, exact response |
| CRUD | validation, errors, repository projection, soft-delete policy |
| Query-heavy read | filters, joins, pagination/count agreement |
| Multi-write transaction | commit, rollback, nested behavior |
| Multipart upload | auth before body, byte/file/field limits |
| Webhook ingress | exact bytes, official verification, durable handoff |
| Binary download | JSON failure versus bytes, MIME, disposition, filename |

Framework verification does not replace application-specific preview and rollback evidence.

After the suite, re-estimate from actual implementation, review, rework, and
defect evidence. Then group remaining routes by proven pattern and risk rather
than by arbitrary file count.

## 8. Move frontends through the structural contract

Generate the client-safe manifest from the compiled graph:

```sh
ship-api contract \
  --app ship.config.ts \
  --out .ship/contract.json \
  --openapi .ship/openapi.json \
  --api-version 4.0.0
```

Frontend code calls stable operation IDs through `OperationClient`. Declared API
failures are values; network and malformed-protocol failures are exceptions.
Preserve status, error code/details, request ID, Retry-After, ETag, content type,
and disposition.

ShipAngular and existing mobile clients may retain an `hc()` compatibility
adapter behind the same resource seam during migration. The generated
application-specific TypeScript contract remains a joint ShipAPI/ShipAngular
release decision and must pass the packed cross-repository fixture.

Deploy tolerant frontend error/download behavior before changing backend traffic
when possible. That removes atomic frontend/backend promotion pressure.

## Streaming

Compatibility `streamSSE`/`streamLLM` routes keep working, but they are invisible
to the graph, manifest, and generated clients. Move each stream to a declared
streaming operation once its module migrates:

```ts
const progress = defineOperation({
  id: "reports.progress",
  transport: http.post("/reports/:reportId/progress", {
    response: {
      mode: "stream",
      framing: "sse",
      frame: progressFrameSchema,
      heartbeatMs: 15_000,
      maxDurationMs: 60_000,
      maxFrames: 1_000,
    },
  }),
  input: { params: reportParams, body: renderOptions },
  output: { 200: renderSummarySchema }, // the terminal value
  successStatus: 200,
  errors: [renderFailed],
  access: permission("reports:render"),
  transaction: "none",
  dependencies: { renderer },
  handler: async ({ input, services, stream }) => {
    for await (const step of services.renderer.run(input, stream.signal)) {
      await stream.emit(step);
    }
    return { steps: input.body.steps };
  },
});
```

What changes for a migrated stream:

- the handler never sees the response; it emits validated frames and returns a
  terminal value, and the adapter owns `text/event-stream` framing, heartbeats,
  `maxDurationMs`/`maxFrames`, and client-abort propagation through
  `stream.signal`;
- access and input validation run before any frame, so denials and validation
  failures keep the unary JSON error envelope; failures after the first frame
  arrive as one final `error` event carrying the same `code`, `status`, and safe
  `message`;
- streams must be `transaction: "none"`; open transactional work per frame or
  per step inside the handler instead;
- `client.call()` returns a `{ frames, terminal, abort, status, error }` handle
  for the operation instead of a promise, and the manifest's `response` field
  tells ShipAngular to do the same;
- for LLM streams, `libraries/ai` exports `streamLLM(stream, events)` to pipe a
  provider iterator through `stream.emit`.

If your compatibility route already writes the Ship layout (`id`, `event`,
`data` per event), the migrated operation produces byte-identical SSE; the exact
bytes, headers, and error codes are frozen in [docs/v4/streaming.md](./v4/streaming.md).

## 9. Gate every migration phase

At minimum, every framework or consumer phase runs:

```sh
pnpm run check
pnpm run type-check
pnpm test
pnpm run test:coverage
pnpm run test:integration
pnpm run build
```

Add graph, route-mapping, parity, packed-package, edge, contract-drift, schema,
and infrastructure gates when the slice touches those surfaces. Tests must be
deterministic, colocated, reviewed, and meet the 80% changed-source target.

No phase completes because source exists. It completes when its named artifact
and executable evidence pass from the exact release candidate.

## 10. Preview and cut over

The safe sequence is:

```text
exact packages
  -> protected migration branch
  -> no-traffic preview
  -> direct smoke and differential suite
  -> frontend preview
  -> rollback rehearsal
  -> dev soak
  -> no-traffic production version
  -> explicit canary traffic
  -> observation and reconciliation
  -> cleanup after rollback window
```

Only one version may own scheduled or correctness-bearing work. Webhooks and
other shared effects require durable cross-version idempotency or version-pinned
routing before canary traffic. Database changes use expand/contract ordering so
the retained application remains usable throughout rollback.

Stop on unexplained schema/data differences, authorization drift, duplicate
effects, an unavailable rollback, contract drift without a tolerant consumer, or
an artifact that differs from the reviewed manifest.

## Compatibility boundary

`@sixthsummit/ship-api`, route-first Hono, `hc<typeof app>()`,
`DrizzleEntityService`, legacy generators, and monolithic jobs/cache/storage stay
supported through the v4 migration window. New operation work should not extend
those abstractions or create a second source of truth. Removal is no earlier than
v5 and requires a measured deprecation window and replacement evidence.

For package ownership and compatibility promises, read
[Public API surface](PUBLIC_API_SURFACE.md), [Versioning](VERSIONING.md), and
[ADR-0012](rearchitecture/decisions/0012-v4-replacement-and-release-boundary.md).
