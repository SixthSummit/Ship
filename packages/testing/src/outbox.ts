import type {
  AnyModule,
  AnyOutbox,
  ApplicationExecutor,
  CompiledApplication,
  IdempotencyClaim,
  IdempotencyContext,
  IdempotencyStore,
  OperationActor,
  OutboxBackend,
  OutboxCleanupResult,
  OutboxDispatchResult,
  OutboxFailureDisposition,
  OutboxHealth,
  OutboxIntentInput,
  OutboxRecord,
  OutboxRecordQuery,
  OutboxRecordResult,
  OutboxRetention,
} from "@sixthsummit/ship-core";
import { isOutbox, systemActor } from "@sixthsummit/ship-core";

/**
 * Deterministic in-memory outbox backend for unit tests.
 *
 * It ignores the unit-of-work scope, so intents are visible as soon as
 * `enqueue()` resolves even if the surrounding fake transaction later fails.
 * Use the Drizzle backend with a real database to prove rollback semantics.
 */
export interface InMemoryOutbox extends OutboxBackend {
  readonly adapter: "memory";
  /** Snapshot of every stored record, oldest first. */
  readonly records: () => readonly OutboxRecord[];
  readonly reset: () => void;
}

export function createInMemoryOutbox(outbox: AnyOutbox): InMemoryOutbox {
  if (!isOutbox(outbox)) {
    throw new TypeError("createInMemoryOutbox requires an outbox created by defineOutbox()");
  }
  let rows: OutboxRecord[] = [];
  let sequence = 0;
  const outboxId = outbox.id;
  const find = (id: string): number => rows.findIndex((row) => row.id === id);
  const replace = (index: number, patch: Partial<OutboxRecord>): OutboxRecord => {
    const next = Object.freeze({ ...rows[index]!, ...patch });
    rows[index] = next;
    return next;
  };

  const record = async (
    _scope: object,
    intents: readonly OutboxIntentInput[],
  ): Promise<readonly OutboxRecordResult[]> =>
    Object.freeze(
      intents.map((intent) => {
        if (
          intent.dedupeKey !== undefined &&
          rows.some((row) => row.intentId === intent.intentId && row.dedupeKey === intent.dedupeKey)
        ) {
          return Object.freeze({ deduplicated: true as const });
        }
        sequence += 1;
        const id = `${outboxId}:${sequence}`;
        rows.push(
          Object.freeze({
            id,
            outboxId,
            intentId: intent.intentId,
            payload: intent.payload,
            ...(intent.dedupeKey !== undefined ? { dedupeKey: intent.dedupeKey } : {}),
            status: "pending" as const,
            attempts: 0,
            availableAt: intent.availableAt,
            createdAt: new Date(),
          }),
        );
        return Object.freeze({ recordId: id, deduplicated: false as const });
      }),
    );

  const claimMatching = async (
    now: Date,
    batchSize: number,
    leaseMs: number,
    matchesIntent: (intentId: string) => boolean,
  ): Promise<readonly OutboxRecord[]> => {
    const claimed: OutboxRecord[] = [];
    const due = rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          matchesIntent(row.intentId) &&
          ((row.status === "pending" && row.availableAt.getTime() <= now.getTime()) ||
            (row.status === "claimed" && (row.leaseExpiresAt?.getTime() ?? 0) <= now.getTime())),
      )
      .sort((left, right) => left.row.availableAt.getTime() - right.row.availableAt.getTime())
      .slice(0, batchSize);
    for (const { index } of due) {
      claimed.push(
        replace(index, {
          status: "claimed",
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        }),
      );
    }
    return Object.freeze(claimed);
  };

  const claimDue = (now: Date, batchSize: number, leaseMs: number, intentIds?: readonly string[]) =>
    claimMatching(now, batchSize, leaseMs, (intentId) =>
      intentIds === undefined ? true : intentIds.includes(intentId),
    );

  const claimUnknownDue = (
    now: Date,
    batchSize: number,
    leaseMs: number,
    knownIntentIds: readonly string[],
  ) => claimMatching(now, batchSize, leaseMs, (intentId) => !knownIntentIds.includes(intentId));

  const complete = async (recordId: string, now: Date): Promise<void> => {
    const index = find(recordId);
    if (index >= 0 && rows[index]!.status === "claimed") {
      replace(index, { status: "completed", completedAt: now, leaseExpiresAt: undefined });
    }
  };

  const fail = async (
    recordId: string,
    error: string,
    disposition: OutboxFailureDisposition,
    now: Date,
  ): Promise<void> => {
    const index = find(recordId);
    if (index < 0 || rows[index]!.status !== "claimed") return;
    const attempts = rows[index]!.attempts + 1;
    if ("deadLetter" in disposition) {
      replace(index, {
        status: "dead-lettered",
        attempts,
        lastError: error,
        deadLetteredAt: now,
        leaseExpiresAt: undefined,
      });
    } else {
      replace(index, {
        status: "pending",
        attempts,
        lastError: error,
        availableAt: disposition.retryAt,
        leaseExpiresAt: undefined,
      });
    }
  };

  const listDeadLettered = async ({ limit }: { readonly limit: number }) =>
    Object.freeze(rows.filter((row) => row.status === "dead-lettered").slice(0, limit));

  const findRecord = async (recordId: string): Promise<OutboxRecord | undefined> => {
    const index = find(recordId);
    return index < 0 ? undefined : rows[index];
  };

  const listRecords = async (query: OutboxRecordQuery): Promise<readonly OutboxRecord[]> =>
    Object.freeze(
      rows
        .filter((row) => query.status === undefined || row.status === query.status)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, query.limit),
    );

  const retry = async (recordId: string, now: Date) => {
    const index = find(recordId);
    if (index < 0 || rows[index]!.status !== "dead-lettered") return undefined;
    return replace(index, { status: "pending", availableAt: now, deadLetteredAt: undefined });
  };

  const discard = async (recordId: string, reason: string, now: Date) => {
    const index = find(recordId);
    if (index < 0 || rows[index]!.status !== "dead-lettered") return undefined;
    return replace(index, { status: "discarded", discardedAt: now, discardReason: reason });
  };

  const cleanup = async (retention: OutboxRetention, now: Date): Promise<OutboxCleanupResult> => {
    let completedDeleted = 0;
    let deadLetteredDeleted = 0;
    rows = rows.filter((row) => {
      if (
        row.status === "completed" &&
        row.completedAt !== undefined &&
        now.getTime() - row.completedAt.getTime() >= retention.completedMs
      ) {
        completedDeleted += 1;
        return false;
      }
      const terminalAt = row.status === "dead-lettered" ? row.deadLetteredAt : row.discardedAt;
      if (
        (row.status === "dead-lettered" || row.status === "discarded") &&
        terminalAt !== undefined &&
        now.getTime() - terminalAt.getTime() >= retention.deadLetteredMs
      ) {
        deadLetteredDeleted += 1;
        return false;
      }
      return true;
    });
    return Object.freeze({ completedDeleted, deadLetteredDeleted });
  };

  const health = async (now: Date): Promise<OutboxHealth> => {
    const pending = rows.filter((row) => row.status === "pending");
    const oldest = pending.reduce<Date | undefined>(
      (best, row) => (best === undefined || row.availableAt < best ? row.availableAt : best),
      undefined,
    );
    return Object.freeze({
      pending: pending.length,
      claimed: rows.filter(
        (row) => row.status === "claimed" && (row.leaseExpiresAt?.getTime() ?? 0) > now.getTime(),
      ).length,
      deadLettered: rows.filter((row) => row.status === "dead-lettered").length,
      ...(oldest ? { oldestPendingAt: oldest } : {}),
    });
  };

  return Object.freeze({
    kind: "ship.outbox-backend" as const,
    adapter: "memory" as const,
    outboxId,
    record,
    claimDue,
    claimUnknownDue,
    complete,
    fail,
    listDeadLettered,
    findRecord,
    listRecords,
    retry,
    discard,
    cleanup,
    health,
    records: () => Object.freeze([...rows]),
    reset: () => {
      rows = [];
      sequence = 0;
    },
  });
}

/** Deterministic in-memory idempotency store for unit tests. */
export interface InMemoryIdempotencyStore extends IdempotencyStore {
  readonly adapter: "memory";
  readonly reset: () => void;
  /** Deletes entries that expired before `before`, optionally only under a key prefix; returns the count. */
  readonly purgeExpired: (before: Date, prefix?: string) => number;
}

export function createInMemoryIdempotencyStore(): InMemoryIdempotencyStore {
  const entries = new Map<
    string,
    { status: "in-flight" | "completed"; result?: unknown; expiresAt: number }
  >();

  const claim = async (
    key: string,
    ttlMs: number,
    context: IdempotencyContext,
  ): Promise<IdempotencyClaim> => {
    const existing = entries.get(key);
    if (existing && existing.expiresAt > context.now.getTime()) {
      return existing.status === "completed" ? "duplicate" : "in-flight";
    }
    entries.set(key, { status: "in-flight", expiresAt: context.now.getTime() + ttlMs });
    return "claimed";
  };

  return Object.freeze({
    kind: "ship.idempotency-store" as const,
    adapter: "memory" as const,
    claim,
    complete: async (key: string, result: unknown) => {
      const existing = entries.get(key);
      if (existing) entries.set(key, { ...existing, status: "completed", result });
    },
    release: async (key: string) => {
      if (entries.get(key)?.status === "in-flight") entries.delete(key);
    },
    readResult: async (key: string, context: IdempotencyContext) => {
      const existing = entries.get(key);
      return existing?.status === "completed" && existing.expiresAt > context.now.getTime()
        ? existing.result
        : undefined;
    },
    reset: () => entries.clear(),
    purgeExpired: (before: Date, prefix = "") => {
      let purged = 0;
      for (const [key, entry] of entries) {
        if (key.startsWith(prefix) && entry.expiresAt < before.getTime()) {
          entries.delete(key);
          purged += 1;
        }
      }
      return purged;
    },
  });
}

export interface DrainOutboxOptions {
  /** Defaults to a system actor named `ship.testing.drain`. */
  readonly actor?: OperationActor;
  /** Safety bound on dispatcher runs; defaults to 100. */
  readonly maxRuns?: number;
}

/**
 * Runs `<outbox>.dispatch` until a pass claims nothing and returns the totals.
 * Pair it with `createInMemoryOutbox()` in unit tests to assert on effects.
 */
export async function drainOutbox(
  executor: ApplicationExecutor<CompiledApplication<string, readonly AnyModule[]>>,
  outbox: AnyOutbox | string,
  options: DrainOutboxOptions = {},
): Promise<OutboxDispatchResult> {
  const outboxId = typeof outbox === "string" ? outbox : outbox.id;
  const operationId = `${outboxId}.dispatch`;
  const actor = options.actor ?? systemActor({ id: "ship.testing.drain" });
  const maxRuns = options.maxRuns ?? 100;
  const totals = { batchSize: 0, claimed: 0, completed: 0, retried: 0, deadLettered: 0 };
  for (let run = 0; run < maxRuns; run += 1) {
    const result = await executor.run(operationId as never, {} as never, { actor });
    if (!result.ok) {
      throw new Error(
        `drainOutbox: ${operationId} failed with ${result.error.code}: ${result.error.message}`,
      );
    }
    const pass = result.data as OutboxDispatchResult;
    // The dispatcher's batch size, reported once; the totals sum the passes.
    totals.batchSize = pass.batchSize;
    totals.claimed += pass.claimed;
    totals.completed += pass.completed;
    totals.retried += pass.retried;
    totals.deadLettered += pass.deadLettered;
    if (pass.claimed === 0) return Object.freeze(totals);
  }
  throw new Error(`drainOutbox: ${operationId} still claimed records after ${maxRuns} runs`);
}
