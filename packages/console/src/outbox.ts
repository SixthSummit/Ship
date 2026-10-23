import type { AnyOutbox, DependencyToken, OutboxBackend } from "@sixthsummit/ship-core";
import {
  defineOperation,
  isOutbox,
  isOutboxBackend,
  operationFailure,
  outboxRecordNotFound,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import { consoleCapabilityUnavailable, consoleOutboxNotFound } from "./errors.js";
import type { ConsolePanelOptions } from "./jobs.js";
import { consoleAccess } from "./permission.js";
import { DEFAULT_LIST_LIMIT, limitQuery, outboxRecordViewSchema, recordView } from "./views.js";

export interface ConsoleOutboxOptions<TPrefix extends string = string>
  extends ConsolePanelOptions<TPrefix> {
  /** Outboxes whose backend tokens are exported by an imported module. */
  readonly outboxes: readonly AnyOutbox[];
}

const RECORD_STATUSES = ["pending", "claimed", "completed", "dead-lettered", "discarded"] as const;

const overviewEntrySchema = z.object({
  outboxId: z.string(),
  intents: z.array(z.string()),
  adapter: z.string().optional(),
  pending: z.number().int(),
  claimed: z.number().int(),
  deadLettered: z.number().int(),
  oldestPendingAt: z.string().optional(),
  capabilities: z.object({ records: z.boolean() }),
});
const overviewOutput = z.object({ outboxes: z.array(overviewEntrySchema) });
const recordsQuery = z.object({
  outboxId: z.string().min(1),
  status: z.enum(RECORD_STATUSES).optional(),
  limit: limitQuery,
});
const recordsOutput = z.object({
  outboxId: z.string(),
  records: z.array(outboxRecordViewSchema),
});
const recordBody = z.object({ outboxId: z.string().min(1), recordId: z.string().min(1) });
const discardBody = recordBody.extend({ reason: z.string().min(1) });
const recordOutput = z.object({ outboxId: z.string(), record: outboxRecordViewSchema });

/**
 * The outbox panel: per-outbox pending, leased and dead-lettered counts,
 * record inspection by status where the backend lists records, and retry or
 * discard of dead-lettered records.
 */
export function defineConsoleOutboxOperations<const TPrefix extends string = string>(
  options: ConsoleOutboxOptions<TPrefix>,
) {
  const { prefix, basePath, clock } = options;
  const outboxes = [...options.outboxes].sort((left, right) => left.id.localeCompare(right.id));
  for (const outbox of outboxes) {
    if (!isOutbox(outbox)) {
      throw new TypeError("console outbox panel accepts only defineOutbox() results");
    }
  }
  const bindings: Record<string, DependencyToken> = {};
  const bindingByOutbox = new Map<string, string>();
  for (const [index, outbox] of outboxes.entries()) {
    bindings[`outbox${index}`] = outbox.backend;
    bindingByOutbox.set(outbox.id, `outbox${index}`);
  }
  const backendOf = (services: object, outboxId: string): OutboxBackend => {
    const binding = bindingByOutbox.get(outboxId);
    const backend = binding ? Reflect.get(services, binding) : undefined;
    if (!isOutboxBackend(backend)) throw operationFailure(consoleOutboxNotFound);
    return backend;
  };

  const overview = defineOperation({
    id: `${prefix}.outbox.overview` as const,
    transport: http.get(`${basePath}/outbox`),
    input: {},
    output: { 200: overviewOutput },
    successStatus: 200,
    errors: [],
    access: consoleAccess(),
    transaction: "none",
    dependencies: bindings,
    handler: async ({ services }) => {
      const entries = [];
      for (const outbox of outboxes) {
        const backend = backendOf(services, outbox.id);
        const health = await backend.health(clock());
        const adapter = Reflect.get(backend, "adapter");
        entries.push({
          outboxId: outbox.id,
          intents: Object.keys(outbox.intents).sort(),
          ...(typeof adapter === "string" ? { adapter } : {}),
          pending: health.pending,
          claimed: health.claimed,
          deadLettered: health.deadLettered,
          ...(health.oldestPendingAt
            ? { oldestPendingAt: health.oldestPendingAt.toISOString() }
            : {}),
          capabilities: { records: typeof backend.listRecords === "function" },
        });
      }
      return { outboxes: entries };
    },
  });

  const records = defineOperation({
    id: `${prefix}.outbox.records` as const,
    transport: http.get(`${basePath}/outbox/records`),
    input: { query: recordsQuery },
    output: { 200: recordsOutput },
    successStatus: 200,
    errors: [consoleOutboxNotFound, consoleCapabilityUnavailable],
    access: consoleAccess(),
    transaction: "none",
    dependencies: bindings,
    handler: async ({ input, services }) => {
      const backend = backendOf(services, input.query.outboxId);
      const limit = input.query.limit ?? DEFAULT_LIST_LIMIT;
      if (backend.listRecords) {
        const listed = await backend.listRecords({
          ...(input.query.status !== undefined ? { status: input.query.status } : {}),
          limit,
        });
        return { outboxId: input.query.outboxId, records: listed.map(recordView) };
      }
      // Every backend can at least list its dead letters.
      if (input.query.status === "dead-lettered") {
        const listed = await backend.listDeadLettered({ limit });
        return { outboxId: input.query.outboxId, records: listed.map(recordView) };
      }
      throw operationFailure(consoleCapabilityUnavailable, {
        details: {
          capability: "outbox.records",
          adapter: String(Reflect.get(backend, "adapter") ?? "unknown"),
        },
      });
    },
  });

  const retry = defineOperation({
    id: `${prefix}.outbox.retry` as const,
    transport: http.post(`${basePath}/outbox/retry`),
    input: { body: recordBody },
    output: { 200: recordOutput },
    successStatus: 200,
    errors: [consoleOutboxNotFound, outboxRecordNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: bindings,
    handler: async ({ input, services }) => {
      const backend = backendOf(services, input.body.outboxId);
      const record = await backend.retry(input.body.recordId, clock());
      if (!record) throw operationFailure(outboxRecordNotFound);
      return { outboxId: input.body.outboxId, record: recordView(record) };
    },
  });

  const discard = defineOperation({
    id: `${prefix}.outbox.discard` as const,
    transport: http.post(`${basePath}/outbox/discard`),
    input: { body: discardBody },
    output: { 200: recordOutput },
    successStatus: 200,
    errors: [consoleOutboxNotFound, outboxRecordNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: bindings,
    handler: async ({ input, services }) => {
      const backend = backendOf(services, input.body.outboxId);
      const record = await backend.discard(input.body.recordId, input.body.reason, clock());
      if (!record) throw operationFailure(outboxRecordNotFound);
      return { outboxId: input.body.outboxId, record: recordView(record) };
    },
  });

  return Object.freeze({
    overview,
    records,
    retry,
    discard,
    operations: Object.freeze([overview, records, retry, discard] as const),
  });
}

export type ConsoleOutboxOperations<TPrefix extends string = string> = ReturnType<
  typeof defineConsoleOutboxOperations<TPrefix>
>;
