/**
 * Module wiring — placeholder.
 *
 * Today, wire modules in `src/index.ts`: that's the type-safe seam for the
 * `hc()` typed client. Each module exposes `buildXxxApp(deps)` — its own
 * bounded sub-app — which you mount on the root with `root.route("/", ...)`.
 * Mounting bounded sub-apps (rather than threading one shared app through
 * every module) keeps each route-type instantiation bounded so the typed
 * client scales. For example, after `ship-api add accounts`:
 *
 *   // src/index.ts
 *   import { buildAccountsApp, AccountService } from "./modules/accounts/index.js";
 *   const { db } = createDb({ config: { connectionString: env.DATABASE_URL }, schema });
 *   const root = createApp({ cors });
 *   const app = root.route("/", buildAccountsApp({ service: new AccountService(db), provider }));
 *   export type ShipApiClient = typeof app;
 *
 * This file is reserved for a planned `ship-api` auto-wiring step that will
 * generate explicit, type-preserving wiring from your installed modules. Until
 * then it intentionally exports nothing — wire in `index.ts`.
 */

export {};
