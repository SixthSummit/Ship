/**
 * Bull-Board admin UI integration — wraps `@bull-board/hono` with API-key
 * auth and auto-discovers queues from the framework's `JobsManager`.
 *
 * **Optional integration.** The `@bull-board/hono` and `@bull-board/api`
 * packages are NOT in the framework's `dependencies` — consumers who
 * want the dashboard install them in their own app. Importing this
 * module without those packages installed throws `MODULE_NOT_FOUND` at
 * import time, which is intentional: the framework doesn't pay for an
 * EJS-based admin UI it doesn't always need.
 *
 * Why API-key auth instead of `requireAuth`:
 *   - Bull-Board is a *static* UI bundle plus a single API surface; the
 *     framework's per-route auth chain isn't a clean fit (Bull-Board
 *     registers its own routes inside `serverAdapter.registerPlugin()`).
 *   - Operators typically guard the dashboard at the network edge
 *     (private subnet, VPN, ingress allowlist) AND at the application
 *     layer (this API key) — defense in depth. Don't expose this on a
 *     public hostname even with the key set.
 *   - The `x-admin-api-key` header is constant-time-compared against
 *     the configured secret to avoid timing oracles.
 *
 * Usage:
 *   ```ts
 *   import { createBullBoardApp } from "@sixthsummit/ship-api/app/services/jobs/bullBoard";
 *
 *   const bb = createBullBoardApp({
 *     jobsManager,
 *     apiKey: env.ADMIN_API_KEY,           // required, ≥32 chars recommended
 *     basePath: "/admin/jobs",             // optional, default "/admin/jobs"
 *   });
 *   app.route(bb.basePath, bb.app);
 *   ```
 *
 * The dashboard auto-refreshes its queue list — but it's a *snapshot*
 * at adapter-construction time. If `defineJob(...)` declarations change
 * after the dashboard is mounted (e.g. dynamic module loading), call
 * `bb.refresh()` to re-derive the queue list.
 */

import { timingSafeEqual } from "node:crypto";
// Bull-Board package types — imported as `type` so the framework
// type-checks even when the runtime packages aren't installed.
// At runtime (when consumers actually mount the dashboard), Node's
// require-time resolution kicks in via the `await import(...)` calls
// in `createBullBoardApp` below.
import type { Hono } from "hono";
import type { JobsManager } from "./JobsManager.js";

export interface BullBoardOptions {
  jobsManager: JobsManager;
  /**
   * API key required on the `x-admin-api-key` header. The framework
   * enforces this is non-empty; production deployments should source it
   * from a secret manager and rotate it independently of JWT keys.
   */
  apiKey: string;
  /**
   * Mount path. Defaults to `/admin/jobs`. The consumer must mount the
   * returned `app` at the same path on the parent Hono — the value
   * passed here is forwarded to Bull-Board's `setBasePath` so the
   * dashboard's static-asset URLs resolve correctly.
   */
  basePath?: string;
}

export interface BullBoardHandle {
  /** The Hono sub-app to `parent.route(basePath, ...)` onto your app. */
  app: Hono;
  /** The configured (or default) base path. */
  basePath: string;
  /** Re-derive the queue list from the JobsManager registry. */
  refresh: () => void;
}

/**
 * Build the Bull-Board sub-app. Throws if `apiKey` is empty. Throws
 * `MODULE_NOT_FOUND` if `@bull-board/hono` / `@bull-board/api` are not
 * installed (framework treats them as optional integrations).
 */
export async function createBullBoardApp(opts: BullBoardOptions): Promise<BullBoardHandle> {
  if (!opts.apiKey || opts.apiKey.length === 0) {
    throw new Error("createBullBoardApp: apiKey is required (set ADMIN_API_KEY in env)");
  }

  const basePath = opts.basePath ?? "/admin/jobs";

  // Dynamic imports — keep these out of the framework's dep tree so the
  // ~30 KB EJS + UI bundle doesn't ship with every consumer.
  const [
    { HonoAdapter },
    { createBullBoard },
    { BullMQAdapter },
    { serveStatic },
    { Hono: HonoCtor },
  ] = await Promise.all([
    import("@bull-board/hono"),
    import("@bull-board/api"),
    import("@bull-board/api/bullMQAdapter"),
    import("@hono/node-server/serve-static"),
    import("hono"),
  ]);

  const serverAdapter = new HonoAdapter(serveStatic);
  serverAdapter.setBasePath(basePath);

  const buildAdapters = () =>
    opts.jobsManager
      .getQueueNames()
      .map((name) => new BullMQAdapter(opts.jobsManager.getQueue(name)));

  const board = createBullBoard({
    queues: buildAdapters(),
    serverAdapter,
  });

  const apiKeyBytes = Buffer.from(opts.apiKey);

  const app = new HonoCtor() as Hono;
  app.use("*", async (c, next) => {
    const supplied = c.req.header("x-admin-api-key");
    if (!supplied) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const suppliedBytes = Buffer.from(supplied);
    // Constant-time compare. Length check first because `timingSafeEqual`
    // throws on mismatched buffer lengths — but the early-return on a
    // length mismatch is itself a small timing channel. The keyspace is
    // operator-controlled, so this is acceptable.
    if (
      suppliedBytes.length !== apiKeyBytes.length ||
      !timingSafeEqual(suppliedBytes, apiKeyBytes)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });
  app.route("/", serverAdapter.registerPlugin());

  return {
    app,
    basePath,
    refresh: () => {
      board.replaceQueues(buildAdapters());
    },
  };
}
