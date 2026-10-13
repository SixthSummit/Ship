import type {
  AuthenticatedAccount,
  AuthProvider,
} from "@sixthsummit/ship-api/app/auth/AuthProvider";
import type { AppEnv } from "@sixthsummit/ship-api/http/app/createApp";
import { createModuleApp } from "@sixthsummit/ship-api/http/app/createApp";
import { NotFoundError } from "@sixthsummit/ship-api/http/errors/NotFoundError";
import { requireAuth } from "@sixthsummit/ship-api/http/middleware/requireAuth";
import { requirePermission } from "@sixthsummit/ship-api/http/middleware/requirePermission";
import { validate } from "@sixthsummit/ship-api/http/utils/validate";
import type { Hono, Schema } from "hono";
import type { BlankSchema } from "hono/types";

import { ACCOUNTS_PERMISSIONS } from "./permissions.js";
import type { AccountService } from "./services/AccountService.js";
import {
  accountIdParamSchema,
  createAccountSchema,
  listAccountsQuerySchema,
  updateAccountSchema,
} from "./validation/schemas.js";

/**
 * v4 routes — `defineAccountsRoutes(app, deps)`.
 *
 * Replaces v3's `Router`-based `routes.ts` + `initializeRoutes(em)`
 * pattern. Differences:
 *   - Returns the chained Hono app so consumer composition keeps RPC
 *     types end-to-end (`hc<typeof app>()` sees every account route).
 *   - Authorization runs at the route via `requirePermission(slug)`
 *     middleware, not the v3 `@HasPermission` decorator on a controller
 *     method.
 *   - Validation runs via `validate('json' | 'query' | 'param', schema)`
 *     wrapping `zValidator`; handlers read parsed input via
 *     `c.req.valid('json' | ...)`.
 *   - 404s throw `NotFoundError` so `app.onError` (registered via
 *     `registerErrorHandlers`) produces the consistent JSON error
 *     shape — handlers don't shape error responses themselves.
 *   - The service is injected (not constructed inside the route file
 *     from an EntityManager) so consumers swap it for tests / custom
 *     subclasses.
 */

export interface AccountsRoutesDeps<TAccount extends AuthenticatedAccount = AuthenticatedAccount> {
  service: AccountService;
  provider: AuthProvider<TAccount>;
}

/**
 * ⚠️ FOOT-GUN: do NOT thread one shared `app` through several modules'
 * `defineXxxRoutes` calls. Chaining every module's routes onto a single app
 * accumulates one giant Hono route-type and detonates `tsc` (TS2589 /
 * "instantiation excessively deep") once you have enough modules. Prefer
 * {@link buildAccountsApp} and mount it on the root with
 * `root.route("/", buildAccountsApp(deps))` — each module then gets its own
 * bounded sub-app. This raw `(app, deps)` form is kept for advanced
 * composition (deliberately registering accounts routes onto an existing
 * already-typed app).
 */
// Generic over Hono's schema param `S`: `.get()`/`.post()` resolve on the
// parameter's declared type, so taking `Hono<AppEnv>` (or `<T extends
// Hono<AppEnv>>`) widens an already-chained app and erases every previously
// registered route from the RPC type. `Hono<AppEnv, S>` accumulates instead —
// the return type is `Hono<AppEnv, S & <these routes>>`.
export function defineAccountsRoutes<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
  S extends Schema = BlankSchema,
>(app: Hono<AppEnv, S>, deps: AccountsRoutesDeps<TAccount>) {
  const auth = requireAuth({ provider: deps.provider });

  return app
    .post(
      "/accounts",
      auth,
      requirePermission(ACCOUNTS_PERMISSIONS.create),
      validate("json", createAccountSchema),
      async (c) => {
        const body = c.req.valid("json");
        const account = await deps.service.create(body);
        return c.json(account, 201);
      },
    )
    .get(
      "/accounts",
      auth,
      requirePermission(ACCOUNTS_PERMISSIONS.read),
      validate("query", listAccountsQuerySchema),
      async (c) => {
        const q = c.req.valid("query");
        const rows = await deps.service.getAll({
          search: q.search,
          where: filterFromQuery(q),
        });
        return c.json(rows, 200);
      },
    )
    .get(
      "/accounts/list",
      auth,
      requirePermission(ACCOUNTS_PERMISSIONS.read),
      validate("query", listAccountsQuerySchema),
      async (c) => {
        const q = c.req.valid("query");
        const offset = (q.page - 1) * q.perPage;
        const result = await deps.service.list({
          search: q.search,
          where: filterFromQuery(q),
          limit: q.perPage,
          offset,
        });
        return c.json({ ...result, page: q.page, perPage: q.perPage }, 200);
      },
    )
    .get(
      "/accounts/count",
      auth,
      requirePermission(ACCOUNTS_PERMISSIONS.read),
      validate("query", listAccountsQuerySchema),
      async (c) => {
        const q = c.req.valid("query");
        const count = await deps.service.count({
          search: q.search,
          where: filterFromQuery(q),
        });
        return c.json({ count }, 200);
      },
    )
    .get(
      "/accounts/:id",
      auth,
      requirePermission(ACCOUNTS_PERMISSIONS.read),
      validate("param", accountIdParamSchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const account = await deps.service.get(id);
        if (account === null) throw new NotFoundError("Account not found");
        return c.json(account, 200);
      },
    )
    .put(
      "/accounts/:id",
      auth,
      requirePermission(ACCOUNTS_PERMISSIONS.update),
      validate("param", accountIdParamSchema),
      validate("json", updateAccountSchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const body = c.req.valid("json");
        const account = await deps.service.update(id, body);
        if (account === null) throw new NotFoundError("Account not found");
        return c.json(account, 200);
      },
    )
    .delete(
      "/accounts/:id",
      auth,
      requirePermission(ACCOUNTS_PERMISSIONS.delete),
      validate("param", accountIdParamSchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const existing = await deps.service.get(id);
        if (existing === null) throw new NotFoundError("Account not found");
        await deps.service.delete(id);
        return c.body(null, 204);
      },
    );
}

/**
 * Build the accounts module as its own sub-app, ready to mount on the root:
 *
 * ```ts
 * const app = createApp({ cors }).route("/", buildAccountsApp({ service, provider }));
 * ```
 *
 * This is the canonical wiring — each module is an independent, bounded
 * sub-app, so the composed `hc()` client type scales without `tsc` overflow.
 * The module owns its registry tag (`createModuleApp("accounts")`), so its
 * routes show up under the `accounts` module in `/dev/routes` and `list_routes`.
 */
export function buildAccountsApp<TAccount extends AuthenticatedAccount = AuthenticatedAccount>(
  deps: AccountsRoutesDeps<TAccount>,
) {
  return defineAccountsRoutes(createModuleApp("accounts"), deps);
}

/**
 * Translates the strict-typed query options into the
 * `DrizzleEntityService.QueryOptions['where']` shape — booleans coerced
 * from "true" / "false", optional fields stripped when absent.
 */
function filterFromQuery(q: {
  isActive?: "true" | "false";
  roleId?: string;
}): Record<string, unknown> | undefined {
  const where: Record<string, unknown> = {};
  if (q.isActive !== undefined) where.isActive = q.isActive === "true";
  if (q.roleId !== undefined) where.roleId = q.roleId;
  return Object.keys(where).length > 0 ? where : undefined;
}
