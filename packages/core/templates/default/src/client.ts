/**
 * Materialized typed client — the "compile before using the client" lever.
 *
 * `hc<typeof app>()` re-instantiates your entire route chain every time a
 * consumer (web / mobile / another service) touches the client — fine for a
 * handful of routes, but as your app grows the per-keystroke type work in the
 * consumer's editor adds up. Hono's recommended fix is to let `tsc` do that
 * instantiation **once** at this package's build, emit it to `.d.ts`
 * (`declaration: true` is set in `tsconfig.json`), and have consumers import
 * the materialized type from your built package instead of re-deriving it from
 * source.
 *
 * Consumers import `hcWithType` / `Client` from here rather than calling
 * `hc<ShipApiClient>()` themselves:
 *
 * ```ts
 * // web / mobile / microservice
 * import { hcWithType } from "@my-org/api/client";
 * export const api = hcWithType(BASE_URL, { init: { credentials: "include" } });
 * const me = await api.accounts[":id"].$get({ param: { id } });
 * ```
 *
 * `import type { ShipApiClient }` is erased at runtime, so importing this file
 * does NOT boot the server in `index.ts` — only the tiny `hono/client` runtime
 * is pulled in.
 */
import { hc } from "@sixthsummit/ship-api/client";
import type { ShipApiClient } from "./index.js";

/** The fully-resolved `hc()` client type for this app. */
export type Client = ReturnType<typeof hc<ShipApiClient>>;

/** `hc()` pre-bound to this app's type — use instead of `hc<ShipApiClient>()`. */
export const hcWithType = (...args: Parameters<typeof hc>): Client => hc<ShipApiClient>(...args);
