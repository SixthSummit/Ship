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
- constructor injection that selects the notification, outbox, webhook event,
  job backend, lock, storage, ledger and idempotency adapters at composition
  time and keeps unit tests network-free through the in-memory backends from
  `@sixthsummit/ship-testing`.
