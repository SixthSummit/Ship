---
"@sixthsummit/ship-hono": minor
"@sixthsummit/ship-drizzle": minor
"@sixthsummit/ship-contract": minor
"@sixthsummit/ship-cli": minor
"@sixthsummit/ship-auth-firebase": minor
"@sixthsummit/ship-cache-redis": minor
"@sixthsummit/ship-jobs-bullmq": minor
"@sixthsummit/ship-observability-otel": minor
"@sixthsummit/ship-realtime-socketio": minor
"@sixthsummit/ship-testing": minor
"@sixthsummit/ship-webhooks": minor
---

Declare `@sixthsummit/ship-core` (and, where used, `@sixthsummit/ship-hono`) as peer dependencies instead of regular dependencies, so an app always has exactly one copy of each.

These packages share ship-core's types, runtime guards and process-wide registries with the app, which only works with a single copy. As regular dependencies, a range that didn't match the app's copy (for example `^1.0.0` next to a `1.1.0-alpha-…` snapshot) made npm silently install a private nested copy. The types and runtime checks then disagreed with the app's copy, and authenticated requests failed with 500. As peers, the package manager uses the app's copy, or fails at install time (npm `ERESOLVE`) when the versions don't fit, instead of duplicating it.

What changes on install:

- `ship-hono`, `ship-drizzle`, `ship-cli`, `ship-cache-redis`, `ship-jobs-bullmq`, `ship-observability-otel`, `ship-testing` and `ship-webhooks` peer on `ship-core`.
- `ship-auth-firebase` and `ship-realtime-socketio` peer on `ship-core` and `ship-hono`.
- `ship-contract` peers on `ship-core` as an optional peer: the browser-safe entry points (`.`, `./client`, `./manifest`) don't need it, while `./application`, `./project`, `./openapi` and `./schema` use the app's copy.
- The `@sixthsummit/ship-api` compatibility distribution is unchanged: it still depends on ship-core and ship-hono directly.

npm 7+ and pnpm install required peers automatically, and every known consumer already lists `@sixthsummit/ship-core` and `@sixthsummit/ship-hono` as direct dependencies, so no manifest change is needed there. An app that installs one of these packages without listing ship-core (or ship-hono) should add it as a direct dependency. With `--legacy-peer-deps` (or npm 6) peers are not installed automatically. A version mismatch that used to be hidden by a nested copy now fails `npm install` with `ERESOLVE`. Align the versions; don't pass `--legacy-peer-deps`.
