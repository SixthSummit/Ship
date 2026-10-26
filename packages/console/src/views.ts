import type {
  JobRun,
  JobRuntimeDeclaration,
  JobTrigger,
  OutboxRecord,
  StoredWebhookEvent,
} from "@sixthsummit/ship-core";
import { jobRunView, outboxRecordView } from "@sixthsummit/ship-core";
import { z } from "zod";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
/** Receipt bodies above this size are summarized by length only. */
export const MAX_BODY_PREVIEW_BYTES = 65_536;

const isoDate = z.string().min(1);

/** Query integers arrive as strings over HTTP; accept both. */
export const limitQuery = z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional();

export const attemptFailureSchema = z.object({
  attempt: z.number().int(),
  error: z.string(),
  at: isoDate,
});

export const runViewSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  input: z.unknown(),
  status: z.string(),
  attempts: z.number().int(),
  history: z.array(attemptFailureSchema),
  createdAt: isoDate,
  availableAt: isoDate,
  key: z.string().optional(),
  dedupeKey: z.string().optional(),
  lastError: z.string().optional(),
  startedAt: isoDate.optional(),
  completedAt: isoDate.optional(),
  failedAt: isoDate.optional(),
  discardedAt: isoDate.optional(),
  discardReason: z.string().optional(),
});

export type ConsoleRunView = z.infer<typeof runViewSchema>;

export const triggerViewSchema = z.object({
  kind: z.enum(["schedule", "interval", "enqueue", "http"]),
  cron: z.string().optional(),
  tz: z.string().optional(),
  everyMs: z.number().int().optional(),
});

export type ConsoleTriggerView = z.infer<typeof triggerViewSchema>;

export const jobOverviewEntrySchema = z.object({
  jobId: z.string(),
  /** False for a job the backend still holds runs for but the application no longer declares. */
  declared: z.boolean(),
  trigger: triggerViewSchema.optional(),
  concurrency: z.object({ mode: z.string(), max: z.number().int() }).optional(),
  retryAttempts: z.number().int().optional(),
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
  lagMs: z.number().int(),
  lastRunAt: isoDate.optional(),
  lastSuccessAt: isoDate.optional(),
  paused: z.boolean(),
});

export const jobCapabilitiesSchema = z.object({
  adapter: z.string(),
  runs: z.boolean(),
  schedules: z.boolean(),
  pause: z.boolean(),
});

export const scheduleViewSchema = z.object({
  jobId: z.string(),
  trigger: triggerViewSchema,
  nextAt: isoDate.optional(),
  lastRunAt: isoDate.optional(),
  lastSuccessAt: isoDate.optional(),
  paused: z.boolean(),
  /** False when the backend holds no reconciled schedule yet (no worker has started). */
  reconciled: z.boolean(),
});

export const outboxRecordViewSchema = z.object({
  id: z.string(),
  intentId: z.string(),
  payload: z.unknown(),
  status: z.string(),
  attempts: z.number().int(),
  availableAt: isoDate,
  createdAt: isoDate,
  dedupeKey: z.string().optional(),
  lastError: z.string().optional(),
  leaseExpiresAt: isoDate.optional(),
  completedAt: isoDate.optional(),
  deadLetteredAt: isoDate.optional(),
  discardedAt: isoDate.optional(),
  discardReason: z.string().optional(),
});

export type ConsoleOutboxRecordView = z.infer<typeof outboxRecordViewSchema>;

export const dispatchViewSchema = z.object({
  recordId: z.string(),
  outboxId: z.string(),
  intentId: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  lastError: z.string().optional(),
  availableAt: isoDate,
  completedAt: isoDate.optional(),
  deadLetteredAt: isoDate.optional(),
});

export const receiptViewSchema = z.object({
  eventId: z.string(),
  webhookId: z.string(),
  provider: z.string(),
  providerEventId: z.string().optional(),
  requestId: z.string(),
  receivedAt: isoDate,
  contentType: z.string().optional(),
  bytes: z.number().int(),
  /** Stored receipts were verified before they were persisted. */
  verification: z.literal("verified"),
  outboxRecordId: z.string().optional(),
  /** The outbox record the receipt spawned, when the backend can look it up. */
  dispatch: dispatchViewSchema.optional(),
});

export type ConsoleReceiptView = z.infer<typeof receiptViewSchema>;

export const receiptDetailSchema = receiptViewSchema.extend({
  /** Already redacted by the kernel before storage. */
  headers: z.record(z.string(), z.string()),
  /** UTF-8 text of the body when it decodes and fits the preview budget. */
  bodyText: z.string().optional(),
});

export function triggerView(trigger: JobTrigger): ConsoleTriggerView {
  switch (trigger.kind) {
    case "schedule":
      return { kind: "schedule", cron: trigger.cron, tz: trigger.tz };
    case "interval":
      return { kind: "interval", everyMs: trigger.everyMs };
    case "http":
      return { kind: "http" };
    default:
      return { kind: "enqueue" };
  }
}

export function runView(run: JobRun): ConsoleRunView {
  const view = jobRunView(run);
  return { ...view, history: view.history.map((item) => ({ ...item })) };
}

export function recordView(record: OutboxRecord): ConsoleOutboxRecordView {
  return {
    ...outboxRecordView(record),
    ...(record.leaseExpiresAt ? { leaseExpiresAt: record.leaseExpiresAt.toISOString() } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt.toISOString() } : {}),
  };
}

export function dispatchView(record: OutboxRecord): z.infer<typeof dispatchViewSchema> {
  return {
    recordId: record.id,
    outboxId: record.outboxId,
    intentId: record.intentId,
    status: record.status,
    attempts: record.attempts,
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
    availableAt: record.availableAt.toISOString(),
    ...(record.completedAt ? { completedAt: record.completedAt.toISOString() } : {}),
    ...(record.deadLetteredAt ? { deadLetteredAt: record.deadLetteredAt.toISOString() } : {}),
  };
}

export function receiptView(
  event: StoredWebhookEvent,
  dispatch?: OutboxRecord,
): ConsoleReceiptView {
  return {
    eventId: event.id,
    webhookId: event.webhookId,
    provider: event.provider,
    ...(event.providerEventId !== undefined ? { providerEventId: event.providerEventId } : {}),
    requestId: event.requestId,
    receivedAt: event.receivedAt.toISOString(),
    ...(event.contentType !== undefined ? { contentType: event.contentType } : {}),
    bytes: event.body.byteLength,
    verification: "verified",
    ...(event.outboxRecordId !== undefined ? { outboxRecordId: event.outboxRecordId } : {}),
    ...(dispatch ? { dispatch: dispatchView(dispatch) } : {}),
  };
}

export function bodyPreview(event: StoredWebhookEvent): string | undefined {
  if (event.body.byteLength > MAX_BODY_PREVIEW_BYTES) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(event.body);
  } catch {
    return undefined;
  }
}

export function declarationSummary(declaration: JobRuntimeDeclaration) {
  return {
    trigger: triggerView(declaration.trigger),
    concurrency: { mode: declaration.concurrency.mode, max: declaration.concurrency.max },
    retryAttempts: declaration.retry.attempts,
  };
}
