import type { Hono, Schema } from "hono";
import type { BlankSchema } from "hono/types";
import type {
  AuthProvider,
  AuthenticatedAccount,
} from "@sixthsummit/ship-api/app/auth/AuthProvider";
import { NotFoundError } from "@sixthsummit/ship-api/http/errors/NotFoundError";
import { createModuleApp } from "@sixthsummit/ship-api/http/app/createApp";
import type { AppEnv } from "@sixthsummit/ship-api/http/app/createApp";
import { requireAuth } from "@sixthsummit/ship-api/http/middleware/requireAuth";
import { requirePermission } from "@sixthsummit/ship-api/http/middleware/requirePermission";
import { validate } from "@sixthsummit/ship-api/http/utils/validate";

import { {{NAME_PLURAL}}_PERMISSIONS } from "./permissions.js";
import { {{NameSingular}}Service } from "./services/{{NameSingular}}Service.js";
import {
  {{nameSingular}}IdParamSchema,
  create{{NameSingular}}Schema,
  list{{NamePlural}}QuerySchema,
  update{{NameSingular}}Schema,
} from "./validation/schemas.js";

export interface {{NamePlural}}RoutesDeps<TAccount extends AuthenticatedAccount = AuthenticatedAccount> {
  service: {{NameSingular}}Service;
  provider: AuthProvider<TAccount>;
}

/**
 * ⚠️ FOOT-GUN: do NOT thread one shared `app` through several modules'
 * `defineXxxRoutes` calls — chaining every module's routes onto a single app
 * accumulates one giant Hono route-type and detonates `tsc` (TS2589) at scale.
 * Prefer {@link build{{NamePlural}}App} mounted via
 * `root.route("/", build{{NamePlural}}App(deps))`. This raw form is kept for
 * advanced composition.
 */
// Generic over Hono's schema param `S`: `.get()`/`.post()` resolve on the
// parameter's declared type, so taking `Hono<AppEnv>` would widen an
// already-chained app and erase previously registered route types from the
// RPC client. `Hono<AppEnv, S>` accumulates instead.
export function define{{NamePlural}}Routes<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
  S extends Schema = BlankSchema,
>(app: Hono<AppEnv, S>, deps: {{NamePlural}}RoutesDeps<TAccount>) {
  const auth = requireAuth({ provider: deps.provider });

  return app
    .post(
      "/{{namePlural}}",
      auth,
      requirePermission({{NAME_PLURAL}}_PERMISSIONS.create),
      validate("json", create{{NameSingular}}Schema),
      async (c) => {
        const body = c.req.valid("json");
        const row = await deps.service.create(body);
        return c.json(row, 201);
      },
    )
    .get(
      "/{{namePlural}}",
      auth,
      requirePermission({{NAME_PLURAL}}_PERMISSIONS.read),
      validate("query", list{{NamePlural}}QuerySchema),
      async (c) => {
        const q = c.req.valid("query");
        const rows = await deps.service.getAll({ search: q.search });
        return c.json(rows, 200);
      },
    )
    .get(
      "/{{namePlural}}/list",
      auth,
      requirePermission({{NAME_PLURAL}}_PERMISSIONS.read),
      validate("query", list{{NamePlural}}QuerySchema),
      async (c) => {
        const q = c.req.valid("query");
        const offset = (q.page - 1) * q.perPage;
        const result = await deps.service.list({
          search: q.search,
          limit: q.perPage,
          offset,
        });
        return c.json(
          { ...result, page: q.page, perPage: q.perPage },
          200,
        );
      },
    )
    .get(
      "/{{namePlural}}/count",
      auth,
      requirePermission({{NAME_PLURAL}}_PERMISSIONS.read),
      validate("query", list{{NamePlural}}QuerySchema),
      async (c) => {
        const q = c.req.valid("query");
        const count = await deps.service.count({ search: q.search });
        return c.json({ count }, 200);
      },
    )
    .get(
      "/{{namePlural}}/:id",
      auth,
      requirePermission({{NAME_PLURAL}}_PERMISSIONS.read),
      validate("param", {{nameSingular}}IdParamSchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const row = await deps.service.get(id);
        if (row === null) throw new NotFoundError("{{NameSingular}} not found");
        return c.json(row, 200);
      },
    )
    .put(
      "/{{namePlural}}/:id",
      auth,
      requirePermission({{NAME_PLURAL}}_PERMISSIONS.update),
      validate("param", {{nameSingular}}IdParamSchema),
      validate("json", update{{NameSingular}}Schema),
      async (c) => {
        const { id } = c.req.valid("param");
        const body = c.req.valid("json");
        const row = await deps.service.update(id, body);
        if (row === null) throw new NotFoundError("{{NameSingular}} not found");
        return c.json(row, 200);
      },
    )
    .delete(
      "/{{namePlural}}/:id",
      auth,
      requirePermission({{NAME_PLURAL}}_PERMISSIONS.delete),
      validate("param", {{nameSingular}}IdParamSchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const existing = await deps.service.get(id);
        if (existing === null) throw new NotFoundError("{{NameSingular}} not found");
        await deps.service.delete(id);
        return c.body(null, 204);
      },
    );
}

/**
 * Build the {{namePlural}} module as its own sub-app, ready to mount on the
 * root: `createApp({ cors }).route("/", build{{NamePlural}}App({ service, provider }))`.
 *
 * Canonical wiring — each module is an independent, bounded sub-app, so the
 * composed `hc()` client type scales without `tsc` overflow. The module owns
 * its registry tag (`createModuleApp("{{namePlural}}")`), so its routes show up
 * under the `{{namePlural}}` module in `/dev/routes` and `list_routes`.
 */
export function build{{NamePlural}}App<TAccount extends AuthenticatedAccount = AuthenticatedAccount>(
  deps: {{NamePlural}}RoutesDeps<TAccount>,
) {
  return define{{NamePlural}}Routes(createModuleApp("{{namePlural}}"), deps);
}
