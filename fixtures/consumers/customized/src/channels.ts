import { defineChannel } from "@sixthsummit/ship-core";
import { z } from "zod";

// Channel payloads are plain Zod schemas: the client manifest derives their
// JSON Schema exactly as it does for operation outputs, so no hand-written
// contractSchema() wrapper is needed. A schema the manifest could not project
// would compile with SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE and type as
// ChannelPayloadNotProjectable in the application contract.
const notificationDeliveredSchema = z.object({
  tenantId: z.string(),
  recipient: z.string().email(),
  subject: z.string(),
  adapter: z.string(),
});
const projectActivitySchema = z.object({
  projectId: z.string().uuid(),
  itemCount: z.number().int().nonnegative(),
});
const reportRequestedSchema = z.object({
  requestId: z.string().uuid(),
  tenantId: z.string(),
  subject: z.string(),
});

/** Each publisher hears about the notifications they requested; the scope key is their actor id. */
export const notificationDelivered = defineChannel({
  id: "reports.delivered",
  scope: "actor",
  payload: notificationDeliveredSchema,
});

/**
 * Published by the durable request path: the event is recorded in the same
 * transaction as the request row and reaches the requester after commit,
 * once the realtime publication dispatcher runs.
 */
export const reportRequested = defineChannel({
  id: "reports.requested",
  scope: "actor",
  payload: reportRequestedSchema,
});

/** Channels the mounted realtime publication module provides publishers for. */
export const publishedChannels = [notificationDelivered, reportRequested] as const;

/** Project activity is addressed by project id; readers must hold the portfolio read permission. */
export const projectActivity = defineChannel({
  id: "portfolio.activity",
  scope: "resource",
  payload: projectActivitySchema,
  presence: true,
  authorizeSubscription: (actor, projectId) =>
    (actor.permissions?.has("portfolio:read") ?? false) &&
    z.string().uuid().safeParse(projectId).success,
});
