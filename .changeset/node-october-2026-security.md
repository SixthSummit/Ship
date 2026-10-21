---
"@sixthsummit/ship-api": patch
"@sixthsummit/ship-hono": patch
"@sixthsummit/ship-cache-redis": patch
"@sixthsummit/ship-testing": patch
"@sixthsummit/ship-drizzle": patch
"@sixthsummit/ship-jobs-bullmq": patch
"@sixthsummit/ship-realtime-socketio": patch
"@sixthsummit/ship-observability-otel": patch
"@sixthsummit/ship-auth-firebase": patch
---

Require the October 2026 Node.js security releases (22.23.4, 24.22.1, 26.12.1 or newer),
which fix the Brotli decoder remote code execution (CVE-2026-111497), TLS hostname
verification bypasses, and `dns.resolve` truncation. Bump `hono` to 4.13.13 to pick up
the `serveStatic` double-decode middleware bypass fix (GHSA-5r4p-p66f-jhc7).

Keep OpenTelemetry on the 2.x SDK line while the ecosystem moves to api 1.10 / SDK 3.0.
OpenTelemetry JS published `@opentelemetry/api` 1.10.0 alongside a new SDK major (core 3.0.0 /
sdk-node 0.300.0); every 2.x SDK package rejects api 1.10.0 as a peer. Three changes keep a
fresh consumer install resolving api 1.9.x:

- `@opentelemetry/api` is constrained to `>=1.9.1 <1.10.0` wherever it is declared.
- `@opentelemetry/core` is now a regular dependency of ship-api and ship-observability-otel,
  so auto-instrumentations-node's peer on it resolves inside those packages instead of
  bubbling to the consumer root.
- ship-testing and ship-auth-firebase declare the bounded `@opentelemetry/api` too. Neither
  imports it directly, but drizzle-orm (testing) and Firestore via firebase-admin
  (auth-firebase) request api with open ranges; without a bound in those subtrees pnpm
  resolves 1.10.0 first and then reuses it for later peer contexts, depending on the order
  dependencies appear in the consumer manifest.

Moving to the OpenTelemetry 3.x line is a separate upgrade.
