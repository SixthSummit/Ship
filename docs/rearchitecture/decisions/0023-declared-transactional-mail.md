# ADR-0023: Declared transactional mail

- **Status:** Accepted
- **Date:** 2026-10-22
- **Scope:** Mailer declaration, message templates, delivery through the jobs capability, per-send idempotency and the send ledger, provider adapters, non-production interception, development previews, contract projection
- **Related:** [ADR-0009](./0009-client-safe-contract-projections.md) · [ADR-0010](./0010-declared-immediate-effects.md) · [ADR-0014](./0014-actor-kinds-and-durable-outbox-delivery.md) · [ADR-0015](./0015-declared-jobs-and-schedules.md)

## Context

Every consumer has written its own email service. One needed a fence so an
arbitrary notification send could not be triggered, then a notification
outbox, then two separate email job tickets; another is injecting its own
email service as part of migration; credential authentication (verification
and reset mail) is about to need a fourth. The failure modes repeat: a send
performed inside a transaction that later rolls back, a retried job that
emails the customer twice, staging sending to a real customer, and nobody able
to answer "did this person get this email" without asking the provider.

The compatibility distribution ships a Resend-backed `EmailService` with a
string template registry. It is an injected service, not a declaration: the
graph cannot see which messages exist, nothing validates a payload before the
template runs, and nothing records a send.

Action Mailer is the reference shape: a mailer per concern, a template per
message, `deliver_later` through the job queue, a delivery method per
environment, interceptors outside production and a preview route in
development.

## Decision

### Mailers are declarations on a module

`defineMailer({ id, from?, replyTo?, messages })` declares a named group of
typed messages. Each message carries a Standard Schema `payload`, a pure
`render(payload) => { subject, html, text }` function and an optional `sample`
payload. A mailer is declared on exactly one module (`defineModule({ mailers })`);
its id is namespaced by that module like every operation id
(`SHIP_MAILER_ID_MISMATCH`), and a second declaration of the same id fails
compilation (`SHIP_MAILER_ID_DUPLICATE`). The application graph gains
`mailers` (id, owning module, `from`, message names) and the module node
lists its mailer ids.

### Templates are TypeScript functions producing an HTML + text pair

A message template is a function of the validated payload that returns the
subject, the HTML body and the plain-text body. There is no MJML, no template
language and no file loader. The kernel stays dependency-free and edge-safe,
the template is type-checked against the payload schema, the same function
renders the development preview, the unit test and the production send, and
`renderMailMessage` validates both the input payload and the rendering shape
(`SHIP_MAIL_PAYLOAD_INVALID`, `SHIP_MAIL_RENDERING_INVALID`). Applications
that want a component renderer compose it inside `render`.

### Delivery is an enqueued job

`@sixthsummit/ship-mail` owns delivery. `defineMailDelivery({ mailers, from?,
interceptor?, retry?, maxInFlight?, retention?, claimLeaseMs? })` compiles one
ordinary job (`mail.deliver` by default) through `defineJob` (ADR-0015): a
system-actor operation with `transaction: "none"`, the mail provider as its
only declared immediate effect (ADR-0010), bounded retry with backoff,
dead-lettering, `ship.jobs:manage` recovery and retention. There is no
synchronous send path.

An operation sends by binding `delivery.dependency`, which resolves to a typed
`MailSender`: `services.mail.send(mailer, "message", { to, payload,
idempotencyKey, cc?, bcc?, replyTo?, headers?, tenantId?, delayMs? })`. The
sender validates recipients and the payload at the call site, so a programming
error surfaces in the caller rather than in a dead letter, then enqueues one
run with `dedupeKey = idempotencyKey`. Queue backpressure is a return value
(`{ accepted: false, rejected: "queue-full" }`), never an exception.

To keep the sender typed without widening the executor, the kernel's job
enqueue token gains an optional `adapt(enqueuer)` hook
(`adaptedJobDependency`). The token keeps `role: "enqueue"` and `job`, so the
graph still records the `enqueues`/`enqueuedBy` edge, `SHIP_JOB_DEPENDENCY_MISSING`
still applies, and the executor still validates the payload against the job
schema; only the value the handler receives is the adapted facade.

A `transaction: "write"` operation may bind the sender, and the run is
enqueued when `send` is called, not at commit. An application that must couple
a send to a commit records an outbox intent (ADR-0014) and sends from the
dispatcher, exactly as it would for any other external effect.

### One ledger row and at most one provider call per idempotency key

The consumer chooses the idempotency key (for example
`verify:${accountId}:${tokenId}`). It deduplicates at enqueue while a run is
live and is the primary key of the send ledger forever after. The delivery
handler renders, applies the interceptor, then calls `ledger.claim`:

- a new key inserts a `sending` row and proceeds;
- a `sent` key returns the stored row and the run completes as `duplicate`
  without touching the provider;
- a `failed` row or a `sending` claim older than `claimLeaseMs` is retaken
  (`attempts + 1`);
- a live `sending` claim held by another run reports `in-flight` and the run
  fails retryably, so the backend retries after backoff.

The provider is called exactly once per successful claim; `markSent` or
`markFailed` records the outcome. Delivery remains at-least-once at the job
level (ADR-0015): a process that dies between the provider call and
`markSent` leaves a `sending` row that is retaken after the lease, and the
provider is asked again with the same idempotency key. Providers that honour
an idempotency key (Resend's `Idempotency-Key`) close that window on their
side; the ledger closes every other one.

`MailLedger` is a kernel contract. `@sixthsummit/ship-drizzle` implements it
over `shipMailSendsTable()` (`ship_mail_sends`: idempotency key, mailer,
message, original recipients, delivered recipients, intercepted flag, subject,
status, attempts, provider, provider message id, last error, tenant id and
timestamps, with a GIN index on recipients so `list({ recipient })` answers
"did this person get this email" from the row alone). The claim is an
`INSERT … ON CONFLICT DO NOTHING` followed by a conditional `UPDATE … RETURNING`;
each statement commits on its own, so concurrent workers holding one key
observe each other immediately. `ship-mail` ships an in-memory ledger with the
same state machine, and `mailLedgerConformance` proves both.

### Provider adapters

`MailProvider` is a kernel contract: `send({ envelope, idempotencyKey, mailerId,
message })` returns `{ accepted: true, providerMessageId? }` or
`{ accepted: false, retryable, error, status? }`. `accepted` means provider
acceptance, never inbox delivery. `ship-mail` ships `logMailProvider` (records
sends in memory, hands them to a sink, can simulate outcomes) and, under its
own subpath, `resendMailProvider` over `fetch` with the idempotency key
forwarded as Resend's `Idempotency-Key` header; rate limits, timeouts, network
errors and 5xx are retryable, any other 4xx is a final `MAIL_REJECTED`
failure that dead-letters the run. The API key never appears in an outcome.
`mailProviderConformance` runs against both.

### Non-production interception

`allowlistInterceptor({ allow, redirectTo, subjectPrefix? })` is applied before
the ledger claim and the provider call. Recipients outside the allowlist
(addresses or `@domains`) are replaced by the redirect inbox, non-allowlisted
`cc`/`bcc` are dropped, the subject is prefixed with the original recipients
and `X-Ship-Original-To` carries them. The ledger records both the addressed
and the delivered recipients plus an `intercepted` flag, so staging evidence is
a row, not a screenshot. The interceptor is bound by the application only
outside production; nothing in the framework reads `NODE_ENV`.

### Development preview

`defineMailPreview({ mailers, prefix?, access?, transport? })` generates
`<prefix>.preview-list` (every mailer and message, with description and
whether a sample exists) and `<prefix>.preview-render` (one message rendered
from its sample through `renderMailMessage`). Both are gated by
`ship.mail:preview` unless the application supplies another non-public
access; a public preview is refused. HTTP transports come from the adapter in
use, so the preview is an ordinary operation the application composes where
previews belong.

### Contract projection

The client contract projects mailer ids and message names only
(`mailers: { [id]: { messages } }`), present only when the application
declares a mailer so existing manifests keep their fingerprint. Templates,
sender addresses, payload schemas and the ledger never reach a client
(ADR-0009).

## Consequences

- Mail is visible in the graph and the contract: `ship-api check` sees every
  mailer and the one job that delivers them, and a client can enumerate
  message names without seeing a template.
- Retry, backoff, dead-lettering, management and retention are the jobs
  capability's; the mail package adds no second queue.
- A replayed, retried or re-enqueued send never calls the provider twice for
  one idempotency key; the only duplicate window is the crash between the
  provider call and `markSent`, which a key-honouring provider also closes.
- Staging cannot email a real customer when the interceptor is bound, and the
  ledger row proves where each message actually went.
- The compatibility `EmailService` remains untouched; nothing in
  `packages/core` changes.
- Consumers pin `@sixthsummit/ship-mail` exactly; applications that do not
  compose a mailer see no new table, job or operation.

## Rejected alternatives

### MJML or a template language

Rejected because it adds a build-time or runtime dependency to every
application, is not type-checked against the payload, and cannot run on the
edge. A function returning an HTML + text pair is the smallest contract that
keeps preview, test and production identical.

### A synchronous `send` that calls the provider inline

Rejected because an inline send inside a transaction commits mail for work
that may roll back, and a retry of the surrounding operation double-sends.
Every send is a job run with a ledger claim.

### Provider-side idempotency alone

Rejected because not every provider offers it, the log adapter has none, and
an application must be able to answer "did this person get this email" from
its own database. The ledger is the guard; provider idempotency is an extra.

### Idempotency through the operation idempotency store

Rejected because that store deduplicates an operation's result for a client
retry window; mail needs a per-send record with recipients, delivery state and
provider id that outlives any window and is queryable by recipient.

### Reading `NODE_ENV` to decide interception

Rejected because the framework never reads the environment to change
behaviour; the application binds the interceptor from its validated
configuration and the ledger records that it did.
