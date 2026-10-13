# Combined capacity baseline

This fixture is the framework-owned load harness for the M10 kernel capabilities
(SAPI-113 step 11). It composes the customized golden consumer's application with
the production adapters (PostgreSQL through Drizzle, BullMQ and the Redis lock on
Redis, the Redis cache backend, the Socket.IO Redis publisher and gateway) and
runs three lanes concurrently against one disposable PostgreSQL and one
disposable Redis:

- **jobs**: `reports.deliver` (keyed single-runner, declared `max: 4`) enqueued
  round-robin across tenant keys at a steady rate, executed by N worker
  processes that also poll the four outbox dispatchers;
- **realtime**: the actor-scoped `reports.delivered` channel published at the
  ADR-0017 rate through the kernel channel publisher, with one subscriber on
  each of two gateway processes counting received, late and dropped messages;
- **webhooks**: bursts of Stripe-signed events into the enqueue-mode
  `payments.stripe-webhook`, one in twenty tampered after signing.

At a fixed interval it samples queue depth, oldest-waiting age and
enqueue-to-start lag, per-tenant completions (fairness), PostgreSQL connection
and lock-wait counts, Redis memory, outbox backlog and every lane's window
counters, then writes a Markdown table and a JSON summary under the repository's
gitignored `.capacity/` directory.

Run it from the repository root:

```sh
pnpm test:capacity          # 600 s load (CAPACITY_DURATION_SECONDS=600)
pnpm test:capacity:short    # 60 s smoke shape (CAPACITY_MODE=short)
```

`scripts/test-capacity.mjs` copies this directory and the consumer's
application source (`fixtures/consumers/customized/src`, minus its tests) outside
the workspace, installs every Ship package from a freshly packed tarball with
recorded provenance, runs the harness's Biome and TypeScript gates, then starts
`src/main.ts`. The `consumer/` directory therefore only exists in the run copy;
it is never committed and never linked to the workspace.

Knobs, measures and what the numbers do and do not claim are documented in
[docs/v4/capacity-baseline.md](../../docs/v4/capacity-baseline.md). The harness
uses no domain vocabulary of its own: tenant keys are `tenant-01..NN`, the two
sessions are a publisher and a subscriber.
