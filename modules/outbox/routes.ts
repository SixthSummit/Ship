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
import { z } from "zod";

import type { OutboxDrainer } from "./OutboxDrainer.js";
import { OUTBOX_PERMISSIONS } from "./permissions.js";
import type { OutboxEvent } from "./schema.js";
import type { OutboxEventService } from "./services/OutboxEventService.js";

/**
 * v4 outbox routes — `defineOutboxRoutes(app, deps)`.
 *
 * Wires:
 *
 *   GET    /outbox          list events (filterable)
 *   GET    /outbox/stats    per-status counts
 *   GET    /outbox/count    total count
 *   GET    /outbox/:id      single event
 *   POST   /outbox/drain    admin: trigger a drain pass
 *   POST   /outbox/recover  admin: reset stale processing
 *
 * Drain + recover are POST (mutating actions), gated by the admin
 * `outbox:drain` / `outbox:recover` permissions. Drain returns the
 * structured per-pass result so the operator sees what just
 * happened. Read-only endpoints sit behind `outbox:read`.
 *
 * Drain by default does *one pass*. Pass `?untilEmpty=true` to flush
 * the entire queue (catch-up after an outage). `batchSize` is also
 * tunable via query param.
 */

export interface OutboxRoutesDeps<TAccount extends AuthenticatedAccount = AuthenticatedAccount> {
  service: OutboxEventService;
  drainer: OutboxDrainer;
  provider: AuthProvider<TAccount>;
}

const idParam = z.object({
  id: z.string().uuid(),
});

const listQuery = z
  .object({
    search: z.string().min(1).optional(),
    eventType: z.string().min(1).optional(),
    status: z.enum(["pending", "processing", "published", "failed"]).optional(),
    page: z.coerce.number().int().positive().default(1),
    perPage: z.coerce.number().int().positive().max(200).default(50),
  })
  .strict();

const drainBody = z
  .object({
    batchSize: z.number().int().positive().max(500).optional(),
    untilEmpty: z.boolean().optional(),
  })
  .strict();

const recoverBody = z
  .object({
    /** Threshold in ms; rows in 'processing' older than this get reset. */
    staleThresholdMs: z.number().int().positive().optional(),
  })
  .strict();

/**
 * ⚠️ FOOT-GUN: do NOT thread one shared `app` through several modules'
 * `defineXxxRoutes` calls — it accumulates one giant Hono route-type and
 * detonates `tsc` (TS2589) at scale. Prefer {@link buildOutboxApp} mounted via
 * `root.route("/", buildOutboxApp(deps))`. This raw form is kept for advanced
 * composition.
 */
// Generic over Hono's schema param `S` so an already-chained app keeps its
// previously registered route types — `Hono<AppEnv>` here would widen them
// away. See defineAccountsRoutes for the full rationale.
export function defineOutboxRoutes<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
  S extends Schema = BlankSchema,
>(app: Hono<AppEnv, S>, deps: OutboxRoutesDeps<TAccount>) {
  const auth = requireAuth({ provider: deps.provider });

  return app
    .get(
      "/outbox",
      auth,
      requirePermission(OUTBOX_PERMISSIONS.outboxRead),
      validate("query", listQuery),
      async (c) => {
        const q = c.req.valid("query");
        const offset = (q.page - 1) * q.perPage;
        const where: Record<string, unknown> = {};
        if (q.eventType) where.eventType = q.eventType;
        if (q.status) where.status = q.status;
        const result = await deps.service.list({
          search: q.search,
          where: Object.keys(where).length > 0 ? where : undefined,
          limit: q.perPage,
          offset,
        });
        const sanitized = (result.rows as OutboxEvent[]).map(summarizeEvent);
        return c.json(
          {
            rows: sanitized,
            total: result.total,
            page: q.page,
            perPage: q.perPage,
          },
          200,
        );
      },
    )
    .get("/outbox/stats", auth, requirePermission(OUTBOX_PERMISSIONS.outboxRead), async (c) => {
      const stats = await deps.service.getStatistics();
      return c.json(stats, 200);
    })
    .get(
      "/outbox/count",
      auth,
      requirePermission(OUTBOX_PERMISSIONS.outboxRead),
      validate("query", listQuery),
      async (c) => {
        const q = c.req.valid("query");
        const where: Record<string, unknown> = {};
        if (q.eventType) where.eventType = q.eventType;
        if (q.status) where.status = q.status;
        const count = await deps.service.count({
          where: Object.keys(where).length > 0 ? where : undefined,
        });
        return c.json({ count }, 200);
      },
    )
    .get(
      "/outbox/:id",
      auth,
      requirePermission(OUTBOX_PERMISSIONS.outboxRead),
      validate("param", idParam),
      async (c) => {
        const { id } = c.req.valid("param");
        const event = (await deps.service.get(id)) as OutboxEvent | null;
        if (!event) throw new NotFoundError("Outbox event not found");
        return c.json(summarizeEvent(event), 200);
      },
    )
    .post(
      "/outbox/drain",
      auth,
      requirePermission(OUTBOX_PERMISSIONS.outboxDrain),
      validate("json", drainBody),
      async (c) => {
        const body = c.req.valid("json");
        const result = body.untilEmpty
          ? await deps.drainer.runUntilEmpty({ batchSize: body.batchSize })
          : await deps.drainer.runOnce({ batchSize: body.batchSize });
        return c.json(result, 200);
      },
    )
    .post(
      "/outbox/recover",
      auth,
      requirePermission(OUTBOX_PERMISSIONS.outboxRecover),
      validate("json", recoverBody),
      async (c) => {
        const body = c.req.valid("json");
        const result = await deps.service.recoverStaleProcessing(body.staleThresholdMs);
        return c.json(result, 200);
      },
    );
}

/**
 * Build the outbox module as its own sub-app, ready to mount on the root with
 * `root.route("/", buildOutboxApp(deps))`. Canonical wiring — see
 * {@link buildAccountsApp} for the rationale. Routes are tagged under the
 * `outbox` module in `/dev/routes` / `list_routes`.
 */
export function buildOutboxApp<TAccount extends AuthenticatedAccount = AuthenticatedAccount>(
  deps: OutboxRoutesDeps<TAccount>,
) {
  return defineOutboxRoutes(createModuleApp("outbox"), deps);
}

/**
 * Strip the heavy `payload` from list-view responses so admin UIs
 * don't transfer megabytes of event bodies just to render a status
 * dashboard. Single-event endpoint returns the full row including
 * payload.
 */
function summarizeEvent(event: OutboxEvent) {
  return {
    id: event.id,
    eventId: event.eventId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    ownerUserId: event.ownerUserId,
    tenantId: event.tenantId,
    correlationId: event.correlationId,
    status: event.status,
    publishAttempts: event.publishAttempts,
    nextAttemptAt: event.nextAttemptAt,
    publishedAt: event.publishedAt,
    lastError: event.lastError,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    payload: event.payload,
  };
}
