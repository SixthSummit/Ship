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

An application that cannot take a Firebase dependency, or whose MFA, lockout
and session-cutoff rules are bespoke code today, has a first-party
alternative: `@sixthsummit/ship-auth-credentials` turns those rules into
configuration and supplies an actor provider with the same `ActorResolver`
contract, so `resolveActor` stays the one piece you write. The two providers
can sit in one adapter, dispatched on credential kind. See
[First-party credential auth](#first-party-credential-auth) under section 6b.

### Framework permissions

Some framework modules generate operations gated by permission slugs of their
own. They are ordinary `permission()` declarations, so your authorization
model must know them before the operations can be reached — a seed-data test
that asserts the full permission set will fail the first time you mount one.

| Slug                   | Introduced by                                                                                                              | Gates                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ship.outbox:manage`   | every `defineOutboxDispatcher` with `deadLetter: true`, including `defineCacheInvalidationModule`, `defineRealtimePublicationModule` and `defineStorageModule` (its purge outbox) | `<outbox>.list-failed`, `<outbox>.retry`, `<outbox>.discard` |
| `ship.jobs:manage`     | `defineJobManagement`                                                                                                      | `<prefix>.list-failed`, `.retry`, `.discard`, `.health`       |
| `ship.webhooks:replay` | `defineWebhookReplay`                                                                                                      | the generated replay operation                                |
| `ship.mail:preview`    | `defineMailPreview` (unless you pass another non-public `access`)                                                          | `<prefix>.preview-list`, `<prefix>.preview-render`           |
| `console.operate`      | `defineConsoleModule` and every console extension; never derived from the three `ship.*` management slugs                 | every console operation                                       |

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

### Schema safety

Once the Drizzle mappings exist, put the generated migrations under
`@sixthsummit/ship-schema-lint` ([schema safety](./v4/features/schema-safety.md),
[ADR-0021](rearchitecture/decisions/0021-schema-safety-gates.md)). The package
is default-off and installs nothing at runtime; it gives the rules above
executable form.

- **Lint.** `ship-schema-lint check drizzle --allowlist schema-lint.allowlist.json`
  reads the migrations in journal order and refuses table and column drops,
  renames, retypes, `NOT NULL` without a default, `SET NOT NULL` on an
  existing table, non-concurrent indexes and backfills inside a DDL
  transaction, printing the safe recipe for each. A deliberate exception
  names the migration tag and the rule with a justification, in the allowlist
  file or inline (`-- ship-schema-lint: allow <rule> <why>`); an entry that
  matches nothing fails the check. Set `baseline` to the last historical
  migration so linting starts with the first migration you write on v4.
- **Snapshot.** `ship-schema-lint snapshot write` captures `schema.snapshot.json`
  from `pg_catalog` (tables, columns, defaults, constraints, indexes, enums);
  `snapshot check` diffs it in CI. A diff with no migration change in the
  same commit is a hand edit.
- **Release step.** `SHIP_RELEASE_STEP=1 ship-schema-lint release --migrations
  drizzle --allowlist … --snapshot …` runs guard, lint, `drizzle-kit migrate`
  and the snapshot check in order; without the variable it exits `3` and
  applies nothing, so an entrypoint that still calls it fails loudly. Replace
  the boot-time `migrate()` call with `assertMigrationsApplied({ client,
  migrationsDir })`, which throws `PendingMigrationsError` and never applies
  anything (`ship-schema-lint pending` is the same check for a container
  entrypoint).
- **CI.** The composite action `.github/actions/schema-safety` wraps the
  preset against a disposable PostgreSQL service as a required check, and
  the deploy job runs the same preset against the target database.

Migrations never run at boot on the kernel line. Every package-owned table in
section 6b (storage ledger, mail sends, credential auth, `ship_job_control`)
arrives through this path like your own tables: spread the table factories
into your schema, `drizzle-kit generate`, lint, release.

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

## 6b. Declared capabilities that replace per-app plumbing

Each of the following was application code in v3 and still is on the
route-first compatibility tier: a storage key layout with its own cleanup
table, an email service with its own retry, a JWT and refresh-token stack, an
HTML sanitizer at every display edge, and an operator reading logs and SQL.
On the kernel line each is a declaration on a module plus an optional
package. The compatibility counterparts stay supported through the migration
window; what follows is what each becomes, what behaves differently, and the
evidence to keep.

### Managed storage

v3 uploads buffer the bytes in the handler (`parseUpload` + `fileSchema`,
[uploads](./v4/features/uploads.md)) and hand them to a `StorageService`
adapter (`DiskStorageAdapter`, `S3StorageAdapter`, `GCSStorageAdapter`), and
everything above the adapter is yours: the key layout, the table that
remembers which object belongs to which row, the cleanup that runs when the
row goes, the fence against a late upload resurrecting a deleted object, and
the thumbnail pipeline. All of that stays supported; the compatibility
adapters, `parseUpload` and `fileSchema` are untouched, and
`http.body.multipart()` remains for an operation that wants the bytes.

Port each file field to a declaration ([managed storage](./v4/features/storage.md),
[ADR-0022](rearchitecture/decisions/0022-declared-managed-storage.md)):

```ts
export const projectPhoto = defineAttachment({
  id: "portfolio.photo",            // <moduleId>.<field>
  cardinality: "many",              // or "single"
  contentTypes: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 5_000_000,
  visibility: "private",            // signed URLs; "public" has a stable URL
  maxCount: 12,
  intentTtlMs: 15 * 60 * 1000,
  variants: { thumb: { width: 320, height: 320, fit: "cover", format: "webp" } },
});
```

The owning module lists it under `attachments`; an operation that touches it
declares `attachments: [projectPhoto]`, binds `projectPhoto.binding` and
receives a capability scoped to the running transaction (`attach`, `detach`,
`list`, `read`, `url`, `variant`). `attach` and `detach` require
`transaction: "write"` (`SHIP_ATTACHMENT_SCOPE_REQUIRED`): the ledger change
and the purge intent commit with the owning row. Mount
`defineStorageModule({ attachments, adapter, ledger, outbox, transports, variants?, sweep? })`
from `@sixthsummit/ship-storage` once; it serves every attachment through
`ship-storage.create-intent`, `ship-storage.complete`, the `ship-storage.sweep`
job, the `ship-storage.purge` outbox and `ship-storage.generate-variant`.
Adapters: `@sixthsummit/ship-storage/disk` (development; signed URLs served by
`createDiskStorageHandler`), `/s3` (AWS S3, Cloudflare R2, MinIO; in-house
SigV4 over Web Crypto, no SDK, single-request uploads up to 5 GiB) and `/gcs`
(an injected `@google-cloud/storage` client). The ledger tables
(`shipStorageIntentsTable`, `shipStorageObjectsTable`,
`shipStoragePurgesTable` from `@sixthsummit/ship-drizzle`, plus the shared
`shipOutboxTable`) go into your schema and through the gated migration path
in section 5; `ship_storage_objects` keeps `purged` rows as an audit trail.

What behaves differently:

- **Bytes never pass through the application server.** The client asks for
  an intent, PUTs to the provider's signed URL, then calls `complete`, which
  re-checks size and type (`UPLOAD_REJECTED` 422 deletes the bytes). An
  expired or already settled intent answers `INTENT_EXPIRED` 410 and deletes
  whatever arrived late, so the sweep and a late completion never both win.
- **Purge is eventual and at-least-once.** Between commit and dispatch the
  object still exists at the provider, but the ledger says `purging` and
  `url()` returns `undefined`. The sweep (a keyed single-runner job) and the
  `ship-storage.purge.dispatch` runner must run; without them `pending`
  intents and `purging` rows accumulate, and `ledger.health()` reports the
  owed purges. Mounting introduces `ship.outbox:manage` and needs a
  `LockProvider`.
- **Variants render lazily.** `variant(objectId, "thumb")` answers
  `{ status: "pending" }` and enqueues the render on first request; the
  first viewer sees the original until the job runs.
- **Tenant isolation is still yours.** `attach` trusts the handler's
  `ownerId`; fold the authentic tenant into it (`<tenantId>/<projectId>`) and
  authorize in the operation as for any repository.

Keep as evidence: an intent left uncompleted moves to `abandoned` after
`intentTtlMs`; deleting an owner records a purge row and the provider object
disappears after dispatch, with a replay a no-op; two tenants with the same
input cannot see each other's objects; `storageAdapterConformance` from
`@sixthsummit/ship-testing/storage` passes for any adapter you write. The
customized golden consumer's `portfolio.photo` (`fixtures/consumers/customized/src/attachments.ts`)
is the reference shape. Angular drives the whole flow from
`@sixthsummit/ship-angular/storage` (`createAttachmentUpload`), with a required
provider-origin allowlist.

### Transactional mail

v3 mail is `libraries/email`: a Resend-backed `EmailService` with a string
template registry, injected and called inline from handlers. Its failure
modes are the ones every consumer has hit: a send inside a transaction that
later rolls back, a retried job that emails the customer twice, staging
mailing a real customer, and no way to answer "did this person get this
email" without asking the provider. The compatibility `EmailService` stays
untouched during the overlap.

Port each message to a mailer on the module that owns it
([transactional mail](./v4/features/mail.md),
[ADR-0023](rearchitecture/decisions/0023-declared-transactional-mail.md)):
`defineMailer({ id, from, replyTo?, messages })`, where each message carries a
`payload` schema, a pure `render(payload) => { subject, html, text }` and a
`sample`; list it under `mailers` on the module. There is no template
language: `render` is a TypeScript function, type-checked against the
payload, and the same function serves the preview, the unit test and the
production send. Then compile delivery once with
`defineMailDelivery({ mailers, interceptor?, retry? })` from
`@sixthsummit/ship-mail`: it produces `delivery.job` (`mail.deliver`, an
ordinary `defineJob` with trigger `enqueue` and `transaction: "none"`) to add
to a module's operations, next to value providers for
`mailProviderDependency()` (`resendMailProvider` from
`@sixthsummit/ship-mail/resend`, or `logMailProvider` for tests) and
`mailLedgerDependency()` (`createDrizzleMailLedger`). An operation binds
`delivery.dependency` and calls
`services.mail.send(mailer, "verifyEmail", { to, payload, idempotencyKey, tenantId? })`;
the message name and payload are checked by TypeScript, and queue backpressure
is a result (`{ accepted: false }`), not an exception. `shipMailSendsTable()`
(`ship_mail_sends`) goes through the gated migration path.

What behaves differently:

- **There is no synchronous send.** `send` enqueues when it is called, not
  at commit. A `transaction: "write"` operation that must not send if it
  rolls back records an outbox intent in the transaction and sends from the
  dispatcher, exactly as for any other external effect (section 6).
- **One provider call per idempotency key.** The key you choose
  (`verify:${accountId}:${tokenId}`) deduplicates while a run is live and is
  the ledger's primary key forever after: a retry, a replay or a second
  enqueue answers `duplicate` without touching the provider. The only
  remaining window is a crash between the provider call and `markSent`,
  which the Resend adapter closes by forwarding the key as `Idempotency-Key`.
- **Staging cannot mail a customer.** `allowlistInterceptor({ allow, redirectTo })`
  replaces every recipient outside the allowlist, drops non-allowlisted
  `cc`/`bcc` and carries the originals in `X-Ship-Original-To`; the ledger
  row records both the addressed and the delivered recipients plus
  `intercepted`. Bind it from your validated configuration; the framework
  never reads `NODE_ENV`.
- **Previews are operations.** `defineMailPreview({ mailers })` adds
  `mail.preview-list` and `mail.preview-render` behind `ship.mail:preview`
  (see *Framework permissions*); attach transports where previews belong.

Keep as evidence: enqueue, drain and replay yield one `sent` ledger row and
one provider call; the interceptor case is a row with `intercepted: true`,
not a screenshot; `mailProviderConformance` and `mailLedgerConformance` from
`@sixthsummit/ship-mail/conformance` pass for any adapter you write. The
customized golden consumer's `reports.mailer` and `reports.email`
(`fixtures/consumers/customized/src/mail.ts`) are the reference shape.

### First-party credential auth

The compatibility line authenticates with `JwtSigner`, `AuthFlow`,
`RefreshTokenStore`, the auth cookies and the `csrf()` middleware over
account tables the application owns, and whatever MFA, lockout or
session-cutoff policy exists is bespoke code. That stack stays as it is; the
kernel package has no compatibility counterpart and is default-off. An
application that cannot take a Firebase dependency, or wants those policies
as configuration, composes `@sixthsummit/ship-auth-credentials`
([credential auth](./v4/features/auth-credentials.md),
[ADR-0025](rearchitecture/decisions/0025-first-party-credential-auth.md)
including its 2026-10-23 addendum). The package is held at proof stage under
the two-consumer rule and publishes as `0.x`; pin it exactly like every other
Ship package.

The pieces: `shipAuthTables()` from `@sixthsummit/ship-auth-credentials/drizzle`
returns the seven `ship_auth_*` tables to spread into your schema and migrate
through the gated release step; `createDrizzleCredentialStore({ database, tables })`
binds the store (`credentialStoreConformance` proves any other).
`defineCredentialAuthMailer({ from, appName })` is one more mailer on the
application's single `defineMailDelivery`. Then
`defineCredentialAuthModule({ store, mailer, mail, links, secrets, policies, sessions?, defaultRoles, clients })`
composes `/auth/*` as declared operations: register, verify-email, sign-in
(`signed-in` | `mfa-required` | `mfa-enrolment-required`), sessions list,
revoke and revoke-all, forgot and reset password, change-password,
change-email, TOTP enrol/confirm/verify and recovery-code consume, every
outcome written to an audit row that never carries a secret. Policies are
configuration: `password`, `lockout`, `session` (absolute age and idle
timeout), `mfa.required` as a function of the account, token TTLs,
`requireVerifiedEmail` and `onExistingEmail`. Rate limiting is
`credentialAuthRateLimitPolicies()` under `preValidationPolicies`.

The actor provider is `credentialAuthentication({ store, clients, session, sessions, resolveActor })`,
passed to `createHonoAdapter` as `auth` with the same `ActorResolver`
contract as the Firebase adapter: the identity is the session
(`ship-credentials.session`), the actor comes from your `resolveActor`, and
per-surface MFA is a line in it (`session.mfaState === "verified"` before
granting `console.operate`). To run beside Firebase, dispatch on the
credential kind as the customized golden consumer's `auth.ts` does, and
forward the adapter's `requires` when you wrap it.

What behaves differently from the compatibility stack:

- **Sessions are opaque hashed tokens, not JWTs**, so revoke-all, the
  account cutoff and a disabled account take effect on the next request and
  sessions are listable. Bearer (`Authorization: Bearer ship_s_…`) is the
  server default for native and machine clients.
- **Browsers use a cookie.** `sessions: { transport: "cookie" | "both" }`
  issues an `httpOnly`, `Secure`, `SameSite=Lax` session cookie, and the
  adapter then requires `credentialSessionCsrfPolicy({ auth, trustedOrigins })`
  under the `"*"` pre-validation key; `createHonoAdapter` refuses to
  construct without it (`SHIP_HONO_OPTIONS_INVALID`). Trusted origins are
  your CORS allowlist. Cookie mode is a same-site deployment: one origin
  behind a proxy, or sibling hosts with `cookie.domain` and
  `cors: { origin: [APP_ORIGIN], credentials: true }`.
- **A stale cookie is cleared, not ignored.** A revoked, expired or idle
  cookie resolves anonymously on a public operation and is refused on an
  authenticated one; either way the response carries a clearing
  `Set-Cookie` and the presentation is audited once as
  `session.stale-cookie`. A present invalid bearer is still refused
  everywhere.
- **argon2id by default** from `node:crypto`, with `needsRehash` upgrading
  scrypt hashes on the next sign-in, so an existing scrypt store needs no
  migration; `scryptPasswordHasher` and any `PasswordHasher` can be bound.
- **Registering an existing email conceals it** (`onExistingEmail:
  "conceal"`, the default): `register` answers `201` and the owner is mailed
  instead, so the endpoint does not enumerate accounts; `links.signIn` is
  required in this mode, and `"reject"` restores the `409`.
- **A password change rotates the current session** whatever its transport,
  revokes the others unless `signOutOtherSessions: false`, and mails the
  owner the `passwordChanged` notice with a short-lived reset link
  (`tokens.passwordChangedResetTtlMs`, ten minutes by default). The change
  stands even if the mail queue refuses the notice (`notified: false`,
  audited as `password.changed-notice`).

Keep as evidence: the migration generated from the spread tables; lockout,
expired and replayed tokens, replayed TOTP steps and recovery codes refused;
revoke-all ending a session during an in-flight request; the CSRF matrix
(missing header, mismatched token, untrusted origin, login CSRF) refused with
a declared `403`; a browser cookie session beside a native bearer. The
customized golden consumer (`fixtures/consumers/customized/src/credential-auth.ts`)
runs both transports with the CSRF policy under `"*"` and forces its `sre`
role through TOTP enrolment before the session reaches the console. Angular
screens come from `@sixthsummit/ship-angular/credential-auth`, where
`cookieSessionStorage()` is the default.

### Rich text fields

v3 formatted content is an HTML string in a `text` column, sanitized in the
client or at whichever display edge remembered to, with pasted images as
bare URLs nobody purges. The kernel line stores a document model instead
([rich text](./v4/features/rich-text.md),
[ADR-0026](rearchitecture/decisions/0026-declared-rich-text-fields.md)):
ProseMirror JSON plus `schemaVersion`, never HTML, validated against a
kernel-owned, versioned allowlist (`RICH_TEXT_SCHEMA_VERSION`; paragraphs,
headings 2–3, lists, blockquote, code block, hard break, `attachment`, and
the `bold`, `italic`, `code` and `link` marks with `https:`/`mailto:` hrefs
only). Tables, images by URL, underline, colour and `h1` are deliberately
absent.

Declare the field on the module that owns the record, with the attachment
its embedded images belong to:

```ts
export const documentBody = defineRichText({
  id: "documents.body",          // <moduleId>.<field>
  attachment: documentImage,     // a defineAttachment on the same module
  extensions: [mergeField],      // defineRichTextExtension: named widenings
  maxBytes: 256 * 1024,
  links: { rel: "noopener noreferrer" },
  onInvalid: "reject",           // or "sanitize"
});
```

List it under `richText` on the module and add
`richTextProvider(documentBody)` from `@sixthsummit/ship-rich-text` to its
providers. An operation validates the body at the input boundary with
`richTextDocumentSchema(documentBody)`, binds `documentBody.binding` and
receives a capability scoped to the running transaction: `validate`,
`sanitize`, `text` (the plain-text projection for search and previews),
`render` (HTML, with signed URLs for embedded objects resolved at render
time and never stored), `save`, `clear` and `migrate`. The table is yours: a
`jsonb` column for the document and a `text` column for the projection; the
framework adds no table for rich text.

What behaves differently:

- **Embedded images are managed objects.** `save({ ownerId, document })`
  inside the write transaction attaches every newly referenced upload of the
  field's attachment and detaches the ones the previous document no longer
  references, recording their purge intents with the row; `clear({ ownerId })`
  on delete. An image lives exactly as long as the owning record. A document
  that references an unknown, purged or foreign object is refused
  (`SHIP_RICH_TEXT_ATTACHMENT_UNAVAILABLE`) or, under `onInvalid: "sanitize"`,
  loses the node.
- **Widening is a declaration.** `defineRichTextExtension({ name, nodes, marks })`
  adds named nodes and marks with a structural `spec` (projected to the
  contract so the editor builds the same schema) and server-only
  `renderHtml` / `renderText`; it cannot redefine a base name.
- **A schema bump is a release step.** `validate`, `render` and `save`
  refuse a document at any other `schemaVersion`
  (`SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED`); the field declares
  `migrations: [{ from, to, migrate }]` and a release step rewrites stored
  rows through `migrate`. Nothing migrates at render time.
- **Converting stored HTML is application work.** The package ships no
  HTML importer. Add the `jsonb` and `text` columns beside the HTML column
  and backfill under the schema-safety recipes rather than retyping in
  place.

Keep as evidence: a refused save changes nothing; dropping an image from a
document and deleting the document both commit the row change and the purge
intent together, and the dispatch deletes the bytes; the XSS corpus in
`packages/rich-text` covers the render path, so your tests cover the
extensions you add (everything an extension emits from `node.attrs` goes
through `context.escape` / `context.attribute`). The customized golden
consumer's `portfolio.document-body` (`fixtures/consumers/customized/src/documents.ts`)
is the reference shape, including the `merge-field` extension. The Angular
editor (`@sixthsummit/ship-angular/rich-text`, `ShipRichTextEditorComponent`)
builds its TipTap schema from the manifest via `richTextFieldFromManifest`,
emits the document model and never HTML, and uploads dropped or pasted images
as managed attachments through `createRichTextAttachmentUploader`.

### Operator console

v3 operations meant Cloud Logging when something stuck, SQL against the
outbox and receipt tables, and the optional `createBullBoardApp`
(`@bull-board/hono` behind an API key) for queues. The kernel line composes
one authenticated surface from declared operations
([operator console](./v4/features/console.md),
[ADR-0024](rearchitecture/decisions/0024-kernel-ops-console.md)); it has no
compatibility counterpart and is default-off until mounted:

```ts
const console = defineConsoleModule({
  imports: ["portfolio", "reports", "payments"],   // modules exporting the bound tokens
  jobs: true,                                      // over jobBackendDependency()
  outboxes: [reportsOutbox, paymentsOutbox],
  webhooks: { webhooks: [stripe, inboundSms], store: webhookEvents, unitOfWork },
  realtime: { backend: realtime, channels: [...publishedChannels] },
});
```

`@sixthsummit/ship-console` mounts, under `console` and `/console`, panels for
jobs (overview, runs, one run, retry, discard, retry-all, pause and resume),
cron (schedules, trigger now), webhooks (receipts with the outbox record each
spawned, one receipt, replay), realtime (channels with subscriber counts) and
outboxes (overview, records, retry, discard). `createHonoAdapter` projects
them like any other operation, so direct execution, HTTP and the generated
client share one access policy and one audit trail.

What to carry into your migration:

- **`console.operate` is never implied.** Every console operation declares
  `permission("console.operate")` (`CONSOLE_OPERATE_PERMISSION`), and the slug
  is not derived from `ship.jobs:manage`, `ship.outbox:manage`,
  `ship.webhooks:replay` or an admin role; grant it explicitly to the role
  that operates the system (see *Framework permissions*). The package proves
  an actor holding every `ship.*` management slug is refused on every console
  operation.
- **Panels degrade per adapter capability.** Introspection is optional on
  each backend contract; a missing one is the declared failure
  `CONSOLE_CAPABILITY_UNAVAILABLE` (501), never a failed mount. Pause and
  resume on the PostgreSQL job backend need the opt-in `shipJobControlTable()`
  (`ship_job_control`) through a gated migration and `controlTable` on
  `createDrizzleJobBackend`.
- **Rejected and duplicate webhook outcomes are process-local.** Stored
  receipts are the verified ones; `createConsoleWebhookObserver()` keeps a
  bounded ring of the others per process.
- **Extensions cannot widen the mount.** `extensions: [{ id, title, operations }]`
  are refused unless every operation is namespaced
  `<consoleId>.<extensionId>.` and declares `consoleAccess()`;
  `credentialAuthConsoleExtension()` from
  `@sixthsummit/ship-auth-credentials/console` is the first.

Keep as evidence: the refusal of your existing operator role on every console
operation, directly and over HTTP; one dead-lettered run retried and one
paused and resumed through the console against your real backend; one
verified receipt listed with its spawned record and replayed. The Angular
console (`@sixthsummit/ship-angular/console`: `provideShipConsole`,
`shipConsoleRoutes({ canActivate })`, `ShipConsoleAppComponent`) runs over the
application's own operation client and refuses an empty guard list.

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

### CORS

The compatibility tier configures cross-origin policy with
`createApp({ cors })`; the kernel adapter takes the same object:
`createHonoAdapter(app, { cors: { origin: env.CORS_ORIGINS, credentials: true } })`,
with the same `CorsOptions` shape (`origin` as one origin, an allowlist or a
per-request resolver, `allowMethods`, `allowHeaders`, `exposeHeaders`,
`maxAge`, `credentials`). Until this landed the adapter emitted no
`Access-Control-*` headers and kernel-line apps wired `hono/cors` by hand;
delete any `app.use("*", cors(...))` wrapper when you pass `cors`, because
the adapter owns the headers and an operation that sets an `Access-Control-*`
header through `respond()` now fails as a reserved header.

What behaves differently from a hand-rolled wrapper:

- a wildcard origin (`"*"`, or `"*"` inside a list) combined with
  `credentials: true` is refused at construction with
  `SHIP_HONO_CORS_INVALID`; list the origins explicitly;
- preflights are answered for operation, streaming and webhook routes, and
  the policy also applies to declared failures and the 404 handler;
- `X-Request-Id`, `X-Ship-Cache` and every header declared on an operation
  error (`Retry-After` on a declared 429) are exposed to the browser; add
  headers your operations set through `respond()` to `exposeHeaders`;
- an explicit `allowHeaders` list always keeps `Content-Type` and
  `X-Request-Id` (and must include `x-csrf-token` for cookie sessions, see
  section 6b); without the list, preflights reflect the browser's request;
- an application that declares an `http.options(...)` operation cannot also
  enable `cors`; the adapter reports the conflict at construction.

New scaffolds read a comma-separated `CORS_ORIGINS` in `src/http.ts`. Keep as
evidence a preflight and a credentialed request from each frontend origin
against one operation, one streaming and one webhook route, and a boot with
the production allowlist. See the top entry of [UPGRADING.md](UPGRADING.md),
the `@sixthsummit/ship-hono` [README](../packages/hono/README.md) and the
*Cross-origin policy* row in [V4_STATUS.md](V4_STATUS.md).

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
