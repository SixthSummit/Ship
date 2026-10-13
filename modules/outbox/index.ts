/**
 * Outbox module — public barrel.
 *
 * Postgres-backed transactional event outbox: emit events inside the
 * same DB transaction as the domain write, then drain to handlers
 * (which typically enqueue BullMQ jobs) outside the transaction.
 * Atomicity with the domain write requires Postgres; Redis-backed
 * BullMQ can't participate.
 *
 * Surface: outbox events table + service + status / lifecycle
 * transition methods + retry/recover helpers + EventEmitter +
 * EventHandlerRegistry + OutboxDrainer + HTTP routes.
 */

export { type EmitEventInput, type EmitEventOptions, OutboxEventEmitter } from "./EventEmitter.js";
export {
  type EventHandler,
  EventHandlerRegistry,
  eventHandlerRegistry,
  type HandlerContext,
} from "./handlers/EventHandler.js";
export {
  OutboxDrainer,
  type OutboxDrainerOptions,
  type OutboxDrainerResult,
} from "./OutboxDrainer.js";
export {
  OUTBOX_PERMISSION_DEFINITIONS,
  OUTBOX_PERMISSIONS,
  type OutboxPermission,
} from "./permissions.js";
export { buildOutboxApp, defineOutboxRoutes, type OutboxRoutesDeps } from "./routes.js";
export {
  computeNextAttempt,
  hasExhaustedRetries,
  isReadyForPublish,
  type NewOutboxEvent,
  type OutboxEvent,
  type OutboxEventStatus,
  outboxEventStatus,
  outboxEvents,
} from "./schema.js";
export { OutboxEventService } from "./services/OutboxEventService.js";
