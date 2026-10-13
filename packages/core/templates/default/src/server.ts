/**
 * Application composition root. `src/index.ts` starts OpenTelemetry and then
 * loads this module dynamically so its dependencies can be instrumented.
 *
 *   1. validates env via `defineEnv` (already done in
 *      `./environment.ts` — importing it triggers validation).
 *   2. composes the root app (`createApp({ cors })`) and mounts each
 *      module's sub-app via `root.route("/", buildXxxApp(deps))`.
 *   3. wires the auth provider (Firebase by default; swap for
 *      Better-Auth/Clerk/WorkOS/Auth.js when those adapters land).
 *   4. starts the HTTP server.
 *
 * The END of the route chain is exported as `ShipApiClient` so client
 * consumers (web, mobile, microservices) can `hc<ShipApiClient>()`
 * end-to-end-typed without codegen — see the v4 cross-framework
 * contract in AGENTS.md. Hono's RPC types live on the RETURN VALUE of
 * each chained `.get()`/`.post()` call — routes register at runtime
 * either way, but a discarded return (or a `typeof app` taken from the
 * bare `createApp()` result) produces a typed client with zero routes.
 */

import { serve } from "@hono/node-server";
import { createApp, registerErrorHandlers, httpLogger } from "@sixthsummit/ship-api";
import { logger } from "@sixthsummit/ship-api/observability/logger";
import { env } from "./environment.js";
// DB wiring (when you add modules): compose the schema via
//   const { db } = createDb({ config: { connectionString: env.DATABASE_URL }, schema });
// import { createDb } from "@sixthsummit/ship-api/app/db/client";
// import { schema } from "./db/schema.js";

// ─── Compose the app ──────────────────────────────────────────────────

const app = createApp({
  // CORS — driven by the `CORS_ORIGINS` env var (a comma-separated
  // allowlist of origins). When unset the framework attaches no CORS
  // middleware; cookies stay same-origin only.
  cors: env.CORS_ORIGINS ? { origin: env.CORS_ORIGINS, credentials: true } : undefined,
  // Health routes: `createApp` already mounts unauthenticated `GET /livez`
  // and `GET /readyz`, ahead of every middleware below — no wiring needed.
  // `createDb(...)` adds a `db.primary` readiness check once you add a
  // database. Configure with `health: { prefix, readyzTimeoutMs }`, or opt
  // out with `health: false`. Don't add `/healthz`: Cloud Run's front end
  // intercepts that path before it reaches the container.
});

registerErrorHandlers(app);
app.use("*", httpLogger());

// Capture the chained return — `routes` carries this route's RPC type;
// a bare `app.get(...)` statement would register it but lose the type.
const routes = app.get("/", (c) => c.json({ ok: true, framework: "ship-api", version: "v4" }));

// ─── Wire your modules ────────────────────────────────────────────────
//
// Modules are copied into your app (e.g. `ship-api add accounts`), so you
// import them from your local `./modules/<name>`, not from the framework.
//
// Each module exposes `buildXxxApp(deps)` — its own bounded sub-app. Mount
// each onto the root with `.route("/", ...)`; modules keep their absolute
// paths, so the client stays flat (`api.accounts.$get`). Chain the mounts and
// point `ShipApiClient` at the end so every route's RPC type survives:
//
// import { buildAccountsApp, AccountService } from "./modules/accounts/index.js";
// import { createDb } from "@sixthsummit/ship-api/app/db/client";
// import { firebaseAuth } from "@sixthsummit/ship-api/app/auth/adapters/firebase";
// import { schema } from "./db/schema.js";
//
// const { db } = createDb({ config: { connectionString: env.DATABASE_URL }, schema });
// const accountService = new AccountService(db);
// const provider = firebaseAuth({ findAccount: (uid) => accountService.findByFirebaseUid(uid) });
// const routedApp = routes
//   .route("/", buildAccountsApp({ service: accountService, provider }));
// export type ShipApiClient = typeof routedApp;   // ← replaces the export below
//
// Mounting each module as its own sub-app (rather than threading one app
// through every `defineXxxRoutes`) keeps each route-type instantiation
// bounded, so the typed client scales to many modules without `tsc` overflow.
// ⚠️ Keep `registerErrorHandlers` + `httpLogger` + cors on the ROOT only —
// never set `onError`/`use("*")` inside a module sub-app (it would shadow the
// uniform AppError shape and per-request logging).

// ─── Export the App type for typed-client consumers ──────────────────

export type ShipApiClient = typeof routes;

// ─── Boot ─────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, environment: env.ENVIRONMENT_NAME }, "ship-api up");
});
