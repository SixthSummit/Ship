---
"@sixthsummit/ship-hono": minor
"@sixthsummit/ship-cli": minor
"@sixthsummit/ship-drizzle": minor
"@sixthsummit/ship-testing": minor
"@sixthsummit/ship-jobs-bullmq": minor
"@sixthsummit/ship-realtime-socketio": minor
---

Declare the shared runtimes an application also imports as peer dependencies instead of regular
dependencies, so one copy is resolved: `hono` in `@sixthsummit/ship-hono`, `drizzle-orm` in
`@sixthsummit/ship-drizzle` and `@sixthsummit/ship-testing`, and `ioredis` in
`@sixthsummit/ship-jobs-bullmq` and `@sixthsummit/ship-realtime-socketio`. Each package keeps the
same caret range in its `devDependencies` for its own tests. `socket.io` and `bullmq` stay regular
dependencies because their adapters create the server, queues and workers themselves; the
compatibility distribution `@sixthsummit/ship-api` is unchanged. The rule is recorded in
`docs/VERSIONING.md`.

Consumers that relied on the transitive copy add the runtime to their own `dependencies` with the
adapter's caret range. `ship-api create` now writes `hono` as the caret range `ship-hono` declares
as its peer next to exact Ship pins, so a caret bump of the Ship packages can never leave an exact
`hono` pin behind, and the packed-consumer gate fails when a clean install of the scaffold or of a
golden consumer resolves more than one `hono` or `drizzle-orm`.
