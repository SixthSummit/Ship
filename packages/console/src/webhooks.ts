import type {
  AnyOutbox,
  AnyWebhook,
  AnyWebhookEnqueueReceive,
  DependencyToken,
  OutboxBackend,
  OutboxRecord,
  StoredWebhookEvent,
  UnitOfWorkDependencyToken,
  WebhookEventStore,
  WebhookObserver,
  WebhookReceiptEvent,
} from "@sixthsummit/ship-core";
import {
  defineOperation,
  defineWebhookReplay,
  isWebhookEventStore,
  operationFailure,
  webhookEventNotFound,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import { consoleCapabilityUnavailable } from "./errors.js";
import type { ConsolePanelOptions } from "./jobs.js";
import { CONSOLE_OPERATE_PERMISSION, consoleAccess } from "./permission.js";
import {
  bodyPreview,
  type ConsoleReceiptView,
  DEFAULT_LIST_LIMIT,
  limitQuery,
  receiptDetailSchema,
  receiptView,
  receiptViewSchema,
} from "./views.js";

const DEFAULT_OBSERVER_CAPACITY = 200;

/** One observed inbound request, including the ones the kernel rejected before storage. */
export interface ObservedWebhookReceipt extends WebhookReceiptEvent {
  readonly at: Date;
}

/**
 * A bounded, process-local ring buffer of receipt outcomes. Stored receipts
 * are only the verified ones; rejected, duplicate and unavailable outcomes
 * never reach the store, so the console records them here. Pass `observer`
 * to the HTTP adapter's `webhooks.observer` (and to `webhookIntent`) next to
 * any metrics observer the application already uses.
 */
export interface ConsoleWebhookObserver {
  readonly kind: "ship.console-webhook-observer";
  readonly observer: WebhookObserver;
  recent(): readonly ObservedWebhookReceipt[];
  reset(): void;
}

export interface ConsoleWebhookObserverOptions {
  /** Outcomes retained per process. Defaults to 200. */
  readonly capacity?: number;
  readonly clock?: () => Date;
  /** Another observer to forward every event to (for example the OpenTelemetry one). */
  readonly forward?: WebhookObserver;
}

export function createConsoleWebhookObserver(
  options: ConsoleWebhookObserverOptions = {},
): ConsoleWebhookObserver {
  const capacity = options.capacity ?? DEFAULT_OBSERVER_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new TypeError("console webhook observer capacity must be a positive integer");
  }
  const clock = options.clock ?? (() => new Date());
  let entries: ObservedWebhookReceipt[] = [];
  const observer: WebhookObserver = {
    received: (event) => {
      entries.push(Object.freeze({ ...event, at: clock() }));
      if (entries.length > capacity) entries = entries.slice(entries.length - capacity);
      options.forward?.received?.(event);
    },
    dispatched: (event) => {
      options.forward?.dispatched?.(event);
    },
  };
  return Object.freeze({
    kind: "ship.console-webhook-observer" as const,
    observer,
    recent: () => Object.freeze([...entries].reverse()),
    reset: () => {
      entries = [];
    },
  });
}

export function isConsoleWebhookObserver(value: unknown): value is ConsoleWebhookObserver {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.console-webhook-observer" &&
    typeof Reflect.get(value, "recent") === "function"
  );
}

export interface ConsoleWebhooksOptions<TPrefix extends string = string>
  extends ConsolePanelOptions<TPrefix> {
  /** Declared webhooks to show; enqueue-mode ones gain receipt listing and replay. */
  readonly webhooks: readonly AnyWebhook[];
  /** The durable raw-event store the enqueue-mode webhooks record into. */
  readonly store: DependencyToken<WebhookEventStore>;
  /** The unit of work replay links the new outbox record in. */
  readonly unitOfWork: UnitOfWorkDependencyToken<unknown>;
  readonly observer?: ConsoleWebhookObserver;
}

const webhookViewSchema = z.object({
  id: z.string(),
  provider: z.string(),
  path: z.string(),
  mode: z.enum(["inline", "enqueue"]),
  outboxId: z.string().optional(),
  intent: z.string().optional(),
});
const observedViewSchema = z.object({
  webhookId: z.string(),
  provider: z.string(),
  outcome: z.string(),
  status: z.number().int(),
  reason: z.string().optional(),
  durationMs: z.number(),
  at: z.string(),
});
const receiptsQuery = z.object({
  webhookId: z.string().min(1).optional(),
  before: z.string().datetime().optional(),
  limit: limitQuery,
});
const receiptsOutput = z.object({
  webhooks: z.array(webhookViewSchema),
  capabilities: z.object({ list: z.boolean(), dispatch: z.boolean(), observed: z.boolean() }),
  receipts: z.array(receiptViewSchema),
  /** Recent outcomes this process observed, newest first; includes rejections. */
  observed: z.array(observedViewSchema),
});
type ReceiptsOutput = z.infer<typeof receiptsOutput>;
const receiptQuery = z.object({ eventId: z.string().min(1) });
const receiptOutput = z.object({ receipt: receiptDetailSchema });

/**
 * The webhooks panel: receipts by endpoint with the outbox record each one
 * spawned, receipt detail with redacted headers and a bounded body preview,
 * recent verification outcomes, and replay (the kernel's own replay
 * operation, gated by `console.operate` instead of `ship.webhooks:replay`).
 */
export function defineConsoleWebhookOperations<const TPrefix extends string = string>(
  options: ConsoleWebhooksOptions<TPrefix>,
) {
  const { prefix, basePath } = options;
  const enqueue = options.webhooks.filter(
    (webhook): webhook is AnyWebhook & { readonly receive: AnyWebhookEnqueueReceive } =>
      webhook.mode === "enqueue" && webhook.receive !== undefined,
  );
  const outboxes = new Map<string, AnyOutbox>();
  for (const webhook of enqueue) outboxes.set(webhook.receive.outbox.id, webhook.receive.outbox);
  const outboxBindings: Record<string, DependencyToken> = {};
  const bindingByOutbox = new Map<string, string>();
  for (const [index, outboxId] of [...outboxes.keys()].sort().entries()) {
    const name = `outbox${index}`;
    outboxBindings[name] = (outboxes.get(outboxId) as AnyOutbox).backend;
    bindingByOutbox.set(outboxId, name);
  }
  const outboxByWebhook = new Map(
    enqueue.map((webhook) => [webhook.id, webhook.receive.outbox.id] as const),
  );
  const webhookViews = Object.freeze(
    [...options.webhooks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((webhook) =>
        Object.freeze({
          id: webhook.id,
          provider: webhook.provider.verifier.id,
          path: webhook.path,
          mode: webhook.mode,
          ...(webhook.receive
            ? { outboxId: webhook.receive.outbox.id, intent: webhook.receive.intent }
            : {}),
        }),
      ),
  );

  const storeOf = (services: object): WebhookEventStore => {
    const store = Reflect.get(services, "events");
    if (!isWebhookEventStore(store)) {
      throw new TypeError(
        `provider ${JSON.stringify(options.store.id)} did not create a webhook event store`,
      );
    }
    return store;
  };

  const dispatchOf = async (
    services: object,
    event: StoredWebhookEvent,
  ): Promise<OutboxRecord | undefined> => {
    if (event.outboxRecordId === undefined) return undefined;
    const binding = bindingByOutbox.get(outboxByWebhook.get(event.webhookId) ?? "");
    const backend = binding ? (Reflect.get(services, binding) as OutboxBackend) : undefined;
    return backend?.findRecord ? backend.findRecord(event.outboxRecordId) : undefined;
  };

  const dispatchSupported = (services: object): boolean =>
    [...bindingByOutbox.values()].every(
      (binding) =>
        typeof (Reflect.get(services, binding) as OutboxBackend).findRecord === "function",
    );

  const receipts = defineOperation({
    id: `${prefix}.webhooks.receipts` as const,
    transport: http.get(`${basePath}/webhooks/receipts`),
    input: { query: receiptsQuery },
    output: { 200: receiptsOutput },
    successStatus: 200,
    errors: [consoleCapabilityUnavailable],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { events: options.store, ...outboxBindings },
    handler: async ({ input, services }) => {
      const store = storeOf(services);
      const observed = (options.observer?.recent() ?? [])
        .filter(
          (entry) =>
            input.query.webhookId === undefined || entry.webhookId === input.query.webhookId,
        )
        .map((entry) => ({
          webhookId: entry.webhookId,
          provider: entry.provider,
          outcome: entry.outcome,
          status: entry.status,
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
          durationMs: entry.durationMs,
          at: entry.at.toISOString(),
        }));
      const result: ReceiptsOutput = {
        webhooks: webhookViews.map((view) => ({ ...view })),
        capabilities: {
          list: typeof store.list === "function",
          dispatch: dispatchSupported(services),
          observed: options.observer !== undefined,
        },
        receipts: [],
        observed,
      };
      if (!store.list) return result;
      const events = await store.list({
        ...(input.query.webhookId !== undefined ? { webhookId: input.query.webhookId } : {}),
        ...(input.query.before !== undefined ? { before: new Date(input.query.before) } : {}),
        limit: input.query.limit ?? DEFAULT_LIST_LIMIT,
      });
      const views: ConsoleReceiptView[] = [];
      for (const event of events) {
        views.push(receiptView(event, await dispatchOf(services, event)));
      }
      return { ...result, receipts: views };
    },
  });

  const receipt = defineOperation({
    id: `${prefix}.webhooks.receipt` as const,
    transport: http.get(`${basePath}/webhooks/receipt`),
    input: { query: receiptQuery },
    output: { 200: receiptOutput },
    successStatus: 200,
    errors: [webhookEventNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { events: options.store, ...outboxBindings },
    handler: async ({ input, services }) => {
      const store = storeOf(services);
      const event = await store.read(input.query.eventId);
      if (!event) throw operationFailure(webhookEventNotFound);
      const preview = bodyPreview(event);
      return {
        receipt: {
          ...receiptView(event, await dispatchOf(services, event)),
          headers: { ...event.headers },
          ...(preview !== undefined ? { bodyText: preview } : {}),
        },
      };
    },
  });

  const replay =
    enqueue.length > 0
      ? defineWebhookReplay({
          id: `${prefix}.webhooks.replay` as const,
          webhooks: enqueue,
          unitOfWork: options.unitOfWork,
          store: options.store,
          permission: CONSOLE_OPERATE_PERMISSION,
          transport: { path: `${basePath}/webhooks/receipts/:eventId/replay` },
        })
      : undefined;

  return Object.freeze({
    receipts,
    receipt,
    replay,
    operations: Object.freeze(replay ? [receipts, receipt, replay] : [receipts, receipt]),
  });
}

export type ConsoleWebhookOperations<TPrefix extends string = string> = ReturnType<
  typeof defineConsoleWebhookOperations<TPrefix>
>;
