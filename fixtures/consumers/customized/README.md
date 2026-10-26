# Customized golden consumer

This fixture is the production-shaped complement to the minimal consumer. It
proves that an application can own its authentication, authorization policy,
tenant boundary, SQL, and infrastructure adapters while ShipAPI supplies the
small compile-and-execute kernel.

The root golden-consumer runner copies the fixture outside the workspace,
installs freshly packed Ship packages, records SHA-256 provenance, and runs its
Biome, TypeScript, unit, build, and real-PostgreSQL integration gates. The
application exercises:

- a custom session credential adapter and application-owned role directory;
- framework permission checks plus an application-owned tenant policy;
- an aggregate, filtered, ordered PostgreSQL query behind an authentic tenant
  capability;
- a declared immediate notification effect;
- a durable outbox path: `reports.request` records the request row and its
  delivery intent in one write transaction, `reports.outbox.dispatch` performs
  the same notifier effect later under a system actor, and
  `reports.outbox.cleanup` applies the declared retention;
- an executor-enforced idempotency key on `reports.request` backed by the
  Drizzle store, so client retries replay the stored result;
- a streaming (`text/event-stream`) progress operation whose frames, terminal
  value, tenant policy, and mid-stream declared error flow through the
  structural client's stream handle;
- two inbound webhooks: `payments.stripe-webhook` verifies the exact Stripe
  bytes and, in enqueue mode, commits the raw event and a `payments.outbox`
  intent together before answering 202 (with permission-gated replay and
  retention cleanup mounted on the legacy route `POST /webhooks/:id/retry`,
  whose `:id` segment carries the event id), while
  `messaging.inbound-sms` verifies Twilio's canonical-URL signature and answers
  inline with TwiML (`response: { mode: "text", contentType: "text/xml" }`) and
  `messaging.sms-status` acknowledges delivery callbacks with a bodiless 200
  (`response: { mode: "empty" }`);
- two declared jobs: a scheduled, keyed single-runner digest that enqueues
  one delivery per enrolled tenant, and the enqueued delivery that re-authorizes
  the tenant as a system actor, writes through the unit of work and records
  the outbox intent in the same transaction; plus the framework retention sweep
  (`jobs.cleanup`, which also sweeps both outboxes) and `ship.jobs:manage`
  dead-letter operations; and
- declared transactional mail: `reports.mailer` (`mail.ts`) renders the digest
  notice from a typed payload, `reports.email` sends it through the typed
  `MailSender` as an enqueued `mail.deliver` run, the `mail` module binds the
  provider and the `ship_mail_sends` ledger, the non-production allowlist
  interceptor redirects real customers to the QA inbox with
  `X-Ship-Original-To`, and the `mail.preview-*` operations render every
  message from its sample;
- a legacy call-site bridge (`bridge.ts`) that publishes to any declared
  channel through a registry derived from the application, narrows to a typed
  publisher where the channel is known, answers every operation call with a
  result through `executor.tryRun`, and runs the realtime publication
  dispatcher with the framework runner instead of the jobs capability;
- plain Zod channel payloads whose JSON Schema the client manifest derives,
  and presence paging plus `actorOnline` on the project activity channel; and
- a declared managed attachment (`portfolio.photo`: many images, 5 MB, private,
  a `thumb` variant) with `portfolio.attach-photo`, `portfolio.remove-photo` and
  `portfolio.photos` over the `@sixthsummit/ship-storage` module: signed upload
  intents, completion fencing, the orphan sweep, a lazily rendered variant, and a
  purge intent that commits with the detachment and is dispatched durably; and
- a declared rich text field (`portfolio.document-body`, `documents.ts`) over
  `@sixthsummit/ship-rich-text`: documents are stored as the sanitized document
  model plus a plain-text projection (`documents.body` / `body_text`), never
  HTML; the field widens the kernel's versioned base schema with a named
  `merge-field` extension whose structural spec reaches the client contract
  while its renderers stay on the server; embedded images are objects of the
  `portfolio.document-image` attachment that `portfolio.save-document`
  attaches and detaches in the same transaction as the row, so a dropped image
  and a deleted document both commit a purge intent and the storage outbox
  removes the bytes; `portfolio.document` renders HTML with signed URLs
  resolved at render time; the real-PostgreSQL test proves an embedded image
  lives exactly as long as the owning row; and
- the operator console (`@sixthsummit/ship-console`) mounted under `/console/*`
  behind the dedicated `console.operate` slug that only the `sre` role holds:
  the `operator` role, which may replay webhooks, is refused on every console
  operation, while an SRE retries a dead-lettered delivery run, pauses and
  resumes the job through the PostgreSQL control table, and replays a stored
  Stripe receipt without touching SQL; and
- first-party credential auth (`@sixthsummit/ship-auth-credentials`, ADR-0025)
  beside the session directory: a composite credential adapter accepts both
  `ShipSession` tokens and `Bearer ship_s_…` sessions and resolves the same
  actor contract; `/auth/*` composes register, verification mail through the
  one `mail.deliver` job, sign-in with lockout, TOTP enrolment and challenge,
  recovery codes, sessions with revoke-all, password reset and change-email
  over the seven package-owned tables (migration `0004_credential_auth`); the
  `sre` role must enrol in TOTP before its session reaches the console, and the
  console's auth-audit panel (extension seam) lists the audit rows an SRE
  reads; sessions run in both transports (SAPI-762): the browser signs in over
  the `httpOnly` session cookie guarded by `credentialSessionCsrfPolicy()` under
  the adapter's `"*"` pre-validation key with the CORS allowlist as the trusted
  origins, native clients keep the bearer; and
- constructor injection that selects the notification, outbox, webhook event,
  job backend, lock, storage, ledger and idempotency adapters at composition
  time and keeps unit tests network-free through the in-memory backends from
  `@sixthsummit/ship-testing`.
