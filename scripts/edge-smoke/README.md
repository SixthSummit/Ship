# Edge runtime smoke test

A minimal Cloudflare Worker that defines an operation and compiles the real
ShipAPI kernel plus generated Hono adapter into an edge-runtime bundle.

## What this catches

The framework's kernel and Hono adapter are supposed to be edge-compatible —
no Node-only deps (`pino`, `pg`, `bullmq`, `@opentelemetry/sdk-node`)
leaking into their package subpaths. This smoke test is the
build-time guard.

If a regression introduces a Node-only import into the kernel or Hono adapter,
`wrangler deploy --dry-run` fails with an unresolvable-module error
and the CI step fails — surfacing the regression at PR-time instead of
at edge-deployment time months later when a consumer tries to ship to
Cloudflare Workers.

## Run locally

```sh
cd scripts/edge-smoke
npx wrangler deploy --dry-run --outdir tmp/wrangler-out
```

Exit code 0 + a `tmp/wrangler-out/index.js` artifact = pass.

## CI integration

The CI workflow runs this step in parallel with the rest of the build.
It's in `.github/workflows/ci.yml` under the `edge-smoke` job.

## Scope

This smoke test verifies **only** that an ordinary JSON operation and its Hono
adapter compile for edge. Other framework subsystems (Drizzle / pg / BullMQ /
OTel) are explicitly Node-only — they're consumed at the consumer's
runtime composition layer, not through these subpaths.

The full edge-runtime adapter set (Drizzle Neon HTTP driver, BullMQ
replacement via Cloudflare Queues, OTel HTTP exporter only) is
deferred to v4.x via `ship-api create --runtime edge`. This smoke test
is the v4.0 contract — it ensures the http/ slice stays clean so that
v4.x adapter work can layer onto it cleanly.
