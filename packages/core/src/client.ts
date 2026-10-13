/**
 * Typed client export — `@sixthsummit/ship-api/client`.
 *
 * The load-bearing subpath for the v4 cross-framework contract: schema
 * changes propagate through TypeScript types end-to-end (Drizzle table →
 * `drizzle-zod` schema → Hono route with `zValidator` → `c.req.valid()`
 * → `hc<ShipApiClient>()` typed client) with **no codegen step**.
 *
 * Why a dedicated subpath: consumers (ShipAngular web, React Native +
 * Expo mobile, internal microservices) only need `hono/client`'s tiny
 * runtime — pulling the full framework barrel would drag in pino /
 * BullMQ / OpenTelemetry / Drizzle / pg, which the client side neither
 * needs nor can run (Hono client is universal; the framework runtime is
 * Node-only). This file re-exports `hc` + the types `hc()` consumers
 * actually use, so the dependency graph stays narrow.
 *
 * # Consumer pattern
 *
 * The consumer's app file pins the typed client by aliasing `typeof app`:
 *
 * ```ts
 * // src/app.ts (server)
 * import { createApp } from "@sixthsummit/ship-api";
 * const app = createApp();
 * // …register module routes…
 * export type ShipApiClient = typeof app;
 * export { app };
 * ```
 *
 * The web / mobile / microservice consumer imports the type only — no
 * runtime cost — and instantiates `hc<ShipApiClient>()`:
 *
 * ```ts
 * // src/api.ts (client)
 * import { hc, type InferRequestType, type InferResponseType }
 *   from "@sixthsummit/ship-api/client";
 * import type { ShipApiClient } from "@my-org/api/app";
 *
 * export const api = hc<ShipApiClient>(import.meta.env.VITE_API_BASE_URL, {
 *   init: { credentials: "include" },     // forward auth cookies
 * });
 *
 * const me = await api.me.$get();
 * if (me.ok) {
 *   const account = await me.json();      // typed end-to-end
 * }
 * ```
 *
 * # Why not export a fixed `ShipApiClient` from the framework
 *
 * The framework registers no application routes itself — `createApp()`
 * returns an empty `Hono<AppEnv>`; modules add the routes the consumer
 * cares about. A framework-side `ShipApiClient` type would describe the
 * framework's own routes (none), not the consumer's. The consumer aliases
 * `typeof app` after their modules register, so the type reflects exactly
 * the routes the consumer's app exposes.
 *
 * # Type-preservation note (sub-apps, mounted at root)
 *
 * Hono's RPC client typing flows through the chained return values of
 * `app.METHOD(...)`. Each module builds its own bounded chain on a fresh
 * `createModuleApp("name")` and the consumer mounts every module onto the
 * root with `root.route("/", subApp)` — modules keep their **absolute**
 * paths, so the client shape and the route registry are identical to a
 * single flat app:
 *
 * ```ts
 * const root = createApp({ cors });
 * registerErrorHandlers(root);          // root owns cross-cutting concerns
 * root.use("*", httpLogger());
 * const app = root
 *   .route("/", buildAccountsApp({ service, provider }))
 *   .route("/", buildOAuthApp({ ... }));
 * export type ShipApiClient = typeof app;   // api.accounts.$get — flat shape
 * ```
 *
 * Mounting each module as its own sub-app (rather than chaining every
 * module's routes onto one app) keeps each TypeScript route-type
 * instantiation bounded, so the typed client scales to many modules
 * without `tsc` blowing its instantiation budget.
 *
 * Module route functions still return the chained app AND stay generic
 * over Hono's schema parameter — `.get()`/`.post()` resolve on the
 * parameter's declared type, so a plain `(app: Hono<AppEnv>)` signature
 * widens an already-chained app and erases every previously registered
 * route from the client type (as does `<T extends Hono<AppEnv>>`, which
 * resolves the methods on the constraint):
 *
 * ```ts
 * export const meRoutes = <S extends Schema>(app: Hono<AppEnv, S>) =>
 *   app.get("/me", requireAuth(), handler);
 * // returns Hono<AppEnv, S & {me route}> — types accumulate per module
 *
 * export const buildMeApp = () => meRoutes(createModuleApp("me"));
 * ```
 */

export {
  type ApplyGlobalResponse,
  type ClientRequest,
  type ClientRequestOptions,
  type ClientResponse,
  DetailedError,
  type Fetch,
  hc,
  type InferRequestType,
  type InferResponseType,
  type PickResponseByStatusCode,
  parseResponse,
} from "hono/client";

/**
 * Optional helper alias — for consumers who want a single named type to
 * pass around their codebase. Equivalent to `ReturnType<typeof hc<TApp>>`
 * but without the generic instantiation noise.
 *
 * ```ts
 * import type { ShipApiClient as InferShipApiClient }
 *   from "@sixthsummit/ship-api/client";
 * import type { ShipApiClient } from "@my-org/api/app";
 *
 * export type Api = InferShipApiClient<ShipApiClient>;
 * ```
 *
 * Type-only alias — costs zero bundle bytes.
 */
export type ShipApiClient<TApp extends import("hono").Hono<any, any, any>> = ReturnType<
  typeof import("hono/client").hc<TApp>
>;

/**
 * `hc()` client narrowed to **success-status** responses (200 | 201) only.
 *
 * ShipAPI shapes every error response centrally — `registerErrorHandlers(app)`
 * turns the AppError taxonomy into a uniform JSON envelope, and the typed
 * client's custom `fetch` handles non-2xx (401 refresh/retry) before your
 * code sees the response. When errors are handled centrally like this, the
 * client doesn't need each route's error-body union; narrowing to the success
 * status simplifies callsite types (`await res.json()` is the 200 body, no
 * `res.ok` discriminator needed) and trims the per-route type the client
 * carries:
 *
 * ```ts
 * import { hc, type ShipApiSuccessClient } from "@sixthsummit/ship-api/client";
 * import type { ShipApiClient as App } from "@my-org/api";
 *
 * // success-only — drops 4xx/5xx response shapes from the client type:
 * const api: ShipApiSuccessClient<App> = hc(BASE_URL, { init: { credentials: "include" } });
 * const account = await (await api.accounts[":id"].$get({ param: { id } })).json();
 * ```
 *
 * Reach for the plain `hc<App>()` form only on the rare route where you need
 * to read a typed error body. Type-only alias — costs zero bundle bytes.
 */
export type ShipApiSuccessClient<TApp extends import("hono").Hono<any, any, any>> = ReturnType<
  typeof import("hono/client").hc<import("hono/client").PickResponseByStatusCode<TApp, 200 | 201>>
>;
