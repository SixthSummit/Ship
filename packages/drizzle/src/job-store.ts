import type {
  JobAttemptFailure,
  JobCleanupResult,
  JobHealthEntry,
  JobIntervalTrigger,
  JobRetention,
  JobRun,
  JobRunQuery,
  JobRunStatus,
  JobScheduleState,
  JobScheduleTrigger,
} from "@sixthsummit/ship-core";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { DrizzleRepositoryError } from "./repository-error.js";

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

/** A failed attempt as persisted in the `history` column. */
export interface JobStoredFailure {
  readonly attempt: number;
  readonly error: string;
  readonly at: string;
}

/**
 * The durable run ledger. Include it in application migrations:
 * `export const jobRuns = shipJobRunsTable();`. One table serves every job;
 * rows are partitioned by `job_id`.
 */
export function shipJobRunsTable(name = "ship_job_runs") {
  assertTableName(name);
  return pgTable(
    name,
    {
      id: text("id").primaryKey(),
      jobId: text("job_id").notNull(),
      input: jsonb("input"),
      key: text("key"),
      dedupeKey: text("dedupe_key"),
      status: text("status").notNull().default("waiting"),
      attempts: integer("attempts").notNull().default(0),
      history: jsonb("history").$type<JobStoredFailure[]>().notNull().default([]),
      lastError: text("last_error"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      failedAt: timestamp("failed_at", { withTimezone: true }),
      discardedAt: timestamp("discarded_at", { withTimezone: true }),
      discardReason: text("discard_reason"),
      leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
      claimToken: text("claim_token"),
    },
    (table) => [
      index(`${name}_claim_idx`).on(table.jobId, table.status, table.availableAt),
      uniqueIndex(`${name}_dedupe_idx`)
        .on(table.jobId, table.dedupeKey)
        .where(sql`status in ('waiting', 'active')`),
    ],
  );
}

export type ShipJobRunsTable = ReturnType<typeof shipJobRunsTable>;

/**
 * Per-job state: the reconciled schedule (`trigger`, `next_at`) and the
 * last-run / last-success marks `health()` reports. Include it in migrations
 * next to `shipJobRunsTable()`.
 */
export function shipJobStateTable(name = "ship_job_state") {
  assertTableName(name);
  return pgTable(name, {
    jobId: text("job_id").primaryKey(),
    trigger: jsonb("trigger").$type<JobScheduleTrigger | JobIntervalTrigger>(),
    nextAt: timestamp("next_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  });
}

export type ShipJobStateTable = ReturnType<typeof shipJobStateTable>;

/**
 * Optional operator control state: a row with `paused_at` set stops every
 * worker from claiming that job's runs until it is cleared. The table is
 * opt-in (`createDrizzleJobBackend({ controlTable })`) so existing
 * deployments change no table shape; without it the backend reports pause
 * as unsupported. Include it in migrations next to the other job tables.
 */
export function shipJobControlTable(name = "ship_job_control") {
  assertTableName(name);
  return pgTable(name, {
    jobId: text("job_id").primaryKey(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  });
}

export type ShipJobControlTable = ReturnType<typeof shipJobControlTable>;

export interface NewJobRun {
  readonly runId: string;
  readonly jobId: string;
  readonly input: unknown;
  readonly key?: string;
  readonly dedupeKey?: string;
  readonly createdAt: Date;
  readonly availableAt: Date;
}

export interface ClaimRequest {
  readonly jobId: string;
  readonly limit: number;
  readonly leaseMs: number;
  /** Keys this process already runs; single-runner jobs skip them to avoid pointless contention. */
  readonly excludeKeys: readonly string[];
}

export interface ClaimedRun extends JobRun {
  /** Fencing token: completion, failure and heartbeats are accepted only while it is current. */
  readonly claimToken: string;
}

export type FailureDisposition = { readonly retryAt: Date } | { readonly deadLetter: true };

/**
 * The persistence port the PostgreSQL job backend runs over. Every method is
 * one statement or one short transaction; the worker loop, scheduling policy
 * and retry policy live in `job-backend.ts` so they can be tested without a
 * database.
 */
export interface JobRunStore {
  /** Inserts a run; returns false when a unique constraint (dedupe or id) already holds. */
  insert(run: NewJobRun): Promise<boolean>;
  /** The non-terminal run id for a dedupe key, when one exists. */
  findDeduplicated(jobId: string, dedupeKey: string): Promise<string | undefined>;
  /** Runs waiting or delayed for a job. */
  countQueued(jobId: string): Promise<number>;
  claim(request: ClaimRequest, now: Date): Promise<readonly ClaimedRun[]>;
  heartbeat(runId: string, claimToken: string, leaseExpiresAt: Date): Promise<boolean>;
  complete(runId: string, jobId: string, claimToken: string, now: Date): Promise<boolean>;
  /** Lock contention: returns the run to waiting without consuming an attempt. */
  reschedule(runId: string, claimToken: string, availableAt: Date): Promise<boolean>;
  fail(
    runId: string,
    claimToken: string,
    failure: JobAttemptFailure,
    disposition: FailureDisposition,
  ): Promise<boolean>;
  /** Replaces the schedule; keeps `next_at` when the trigger is unchanged. */
  upsertSchedule(
    jobId: string,
    trigger: JobScheduleTrigger | JobIntervalTrigger,
    nextAt: Date,
  ): Promise<void>;
  deleteSchedule(jobId: string): Promise<void>;
  /**
   * Enqueues one run per due schedule (id `<jobId>/<occurrence>`) and advances
   * `next_at` to the first occurrence after `now`; rows are claimed with
   * `FOR UPDATE SKIP LOCKED` so concurrent processes never double-tick.
   */
  tick(
    jobIds: readonly string[],
    now: Date,
    advance: (trigger: JobScheduleTrigger | JobIntervalTrigger, from: Date) => Date,
  ): Promise<number>;
  health(jobIds: readonly string[], now: Date): Promise<readonly JobHealthEntry[]>;
  listFailed(limit: number): Promise<readonly JobRun[]>;
  retry(runId: string, now: Date): Promise<JobRun | undefined>;
  discard(runId: string, reason: string, now: Date): Promise<JobRun | undefined>;
  cleanup(
    retention: ReadonlyMap<string, JobRetention>,
    fallback: JobRetention,
    now: Date,
  ): Promise<JobCleanupResult>;
  /** Runs matching the query, most recently created first; `delayed` means waiting past `now`. */
  listRuns(query: JobRunQuery, now: Date): Promise<readonly JobRun[]>;
  getRun(runId: string, now: Date): Promise<JobRun | undefined>;
  listSchedules(): Promise<readonly JobScheduleState[]>;
  /** Ids of paused jobs; empty when the store has no control table. */
  listPaused(): Promise<readonly string[]>;
  /** Present only when the store holds control state; see `shipJobControlTable`. */
  setPaused?(jobId: string, paused: boolean, now: Date): Promise<void>;
}

type Executor = NodePgDatabase<Record<string, unknown>>;

export function createDrizzleJobRunStore(
  database: NodePgDatabase<Record<string, unknown>>,
  runs: ShipJobRunsTable,
  state: ShipJobStateTable,
  control?: ShipJobControlTable,
): JobRunStore {
  const db: Executor = database;

  const insert = async (run: NewJobRun) => {
    const inserted = await db
      .insert(runs)
      .values({
        id: run.runId,
        jobId: run.jobId,
        input: run.input === undefined ? null : run.input,
        key: run.key ?? null,
        dedupeKey: run.dedupeKey ?? null,
        status: "waiting",
        attempts: 0,
        history: [],
        createdAt: run.createdAt,
        availableAt: run.availableAt,
      })
      .onConflictDoNothing()
      .returning({ id: runs.id });
    return inserted.length === 1;
  };

  const findDeduplicated = async (jobId: string, dedupeKey: string) => {
    const [row] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.jobId, jobId),
          eq(runs.dedupeKey, dedupeKey),
          inArray(runs.status, ["waiting", "active"]),
        ),
      )
      .limit(1);
    return row?.id;
  };

  const countQueued = async (jobId: string) => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.jobId, jobId), eq(runs.status, "waiting")));
    return row?.count ?? 0;
  };

  const claim = async (request: ClaimRequest, now: Date) => {
    if (request.limit <= 0) return Object.freeze([]);
    const claimToken = globalThis.crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + request.leaseMs);
    const rows = await db.transaction(async (tx) => {
      const due = tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.jobId, request.jobId),
            or(
              and(eq(runs.status, "waiting"), lte(runs.availableAt, now)),
              and(eq(runs.status, "active"), lte(runs.leaseExpiresAt, now)),
            ),
            request.excludeKeys.length > 0
              ? or(sql`${runs.key} is null`, notInArray(runs.key, [...request.excludeKeys]))
              : undefined,
          ),
        )
        .orderBy(asc(runs.availableAt), asc(runs.createdAt))
        .limit(request.limit)
        .for("update", { skipLocked: true });
      const claimed = await tx
        .update(runs)
        .set({
          status: "active",
          attempts: sql`${runs.attempts} + 1`,
          startedAt: now,
          leaseExpiresAt,
          claimToken,
        })
        .where(inArray(runs.id, due))
        .returning();
      if (claimed.length > 0) {
        await tx
          .insert(state)
          .values({ jobId: request.jobId, lastRunAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: state.jobId,
            set: { lastRunAt: now, updatedAt: now },
          });
      }
      return claimed;
    });
    return Object.freeze(
      rows
        .sort(
          (left, right) =>
            left.availableAt.getTime() - right.availableAt.getTime() ||
            left.createdAt.getTime() - right.createdAt.getTime(),
        )
        .map((row) => Object.freeze({ ...toRun(row), claimToken })),
    );
  };

  const owned = (runId: string, claimToken: string) =>
    and(eq(runs.id, runId), eq(runs.status, "active"), eq(runs.claimToken, claimToken));

  const heartbeat = async (runId: string, claimToken: string, leaseExpiresAt: Date) => {
    const updated = await db
      .update(runs)
      .set({ leaseExpiresAt })
      .where(owned(runId, claimToken))
      .returning({ id: runs.id });
    return updated.length === 1;
  };

  const complete = async (runId: string, jobId: string, claimToken: string, now: Date) =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(runs)
        .set({ status: "completed", completedAt: now, leaseExpiresAt: null, claimToken: null })
        .where(owned(runId, claimToken))
        .returning({ id: runs.id });
      if (updated.length !== 1) return false;
      await tx
        .insert(state)
        .values({ jobId, lastSuccessAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: state.jobId,
          set: { lastSuccessAt: now, updatedAt: now },
        });
      return true;
    });

  const reschedule = async (runId: string, claimToken: string, availableAt: Date) => {
    const updated = await db
      .update(runs)
      .set({
        status: "waiting",
        attempts: sql`greatest(${runs.attempts} - 1, 0)`,
        availableAt,
        leaseExpiresAt: null,
        claimToken: null,
      })
      .where(owned(runId, claimToken))
      .returning({ id: runs.id });
    return updated.length === 1;
  };

  const fail = async (
    runId: string,
    claimToken: string,
    failure: JobAttemptFailure,
    disposition: FailureDisposition,
  ) => {
    const entry: JobStoredFailure = {
      attempt: failure.attempt,
      error: failure.error,
      at: failure.at.toISOString(),
    };
    const updated = await db
      .update(runs)
      .set({
        history: sql`${runs.history} || ${JSON.stringify([entry])}::jsonb`,
        lastError: failure.error,
        leaseExpiresAt: null,
        claimToken: null,
        ...("deadLetter" in disposition
          ? { status: "failed", failedAt: failure.at }
          : { status: "waiting", availableAt: disposition.retryAt }),
      })
      .where(owned(runId, claimToken))
      .returning({ id: runs.id });
    return updated.length === 1;
  };

  const upsertSchedule = async (
    jobId: string,
    trigger: JobScheduleTrigger | JobIntervalTrigger,
    nextAt: Date,
  ) => {
    const now = new Date();
    await db
      .insert(state)
      .values({ jobId, trigger, nextAt, updatedAt: now })
      .onConflictDoUpdate({
        target: state.jobId,
        set: {
          trigger,
          nextAt: sql`case when ${state.trigger} = excluded.trigger and ${state.nextAt} is not null then ${state.nextAt} else excluded.next_at end`,
          updatedAt: now,
        },
      });
  };

  const deleteSchedule = async (jobId: string) => {
    await db
      .update(state)
      .set({ trigger: null, nextAt: null, updatedAt: new Date() })
      .where(eq(state.jobId, jobId));
  };

  const tick = async (
    jobIds: readonly string[],
    now: Date,
    advance: (trigger: JobScheduleTrigger | JobIntervalTrigger, from: Date) => Date,
  ) => {
    if (jobIds.length === 0) return 0;
    return db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(state)
        .where(
          and(inArray(state.jobId, [...jobIds]), isNotNull(state.trigger), lte(state.nextAt, now)),
        )
        .orderBy(asc(state.jobId))
        .for("update", { skipLocked: true });
      let enqueued = 0;
      for (const row of due) {
        const trigger = row.trigger as JobScheduleTrigger | JobIntervalTrigger;
        const occurrence = row.nextAt as Date;
        const inserted = await tx
          .insert(runs)
          .values({
            id: `${row.jobId}/${occurrence.toISOString()}`,
            jobId: row.jobId,
            input: {},
            status: "waiting",
            attempts: 0,
            history: [],
            createdAt: occurrence,
            availableAt: occurrence,
          })
          .onConflictDoNothing()
          .returning({ id: runs.id });
        enqueued += inserted.length;
        let next = occurrence;
        while (next.getTime() <= now.getTime()) next = advance(trigger, next);
        await tx
          .update(state)
          .set({ nextAt: next, updatedAt: now })
          .where(eq(state.jobId, row.jobId));
      }
      return enqueued;
    });
  };

  const health = async (jobIds: readonly string[], now: Date) => {
    const counts = await db
      .select({
        jobId: runs.jobId,
        waiting: sql<number>`count(*) filter (where ${runs.status} = 'waiting' and ${runs.availableAt} <= ${now})::int`,
        delayed: sql<number>`count(*) filter (where ${runs.status} = 'waiting' and ${runs.availableAt} > ${now})::int`,
        active: sql<number>`count(*) filter (where ${runs.status} = 'active')::int`,
        failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
        oldestWaitingAt:
          sql<Date | null>`min(${runs.availableAt}) filter (where ${runs.status} = 'waiting' and ${runs.availableAt} <= ${now})`.mapWith(
            runs.availableAt,
          ),
      })
      .from(runs)
      .groupBy(runs.jobId);
    const marks = await db.select().from(state);
    const ids = [...new Set([...jobIds, ...counts.map((row) => row.jobId)])].sort();
    return Object.freeze(
      ids.map((jobId) => {
        const count = counts.find((row) => row.jobId === jobId);
        const mark = marks.find((row) => row.jobId === jobId);
        return Object.freeze({
          jobId,
          waiting: count?.waiting ?? 0,
          active: count?.active ?? 0,
          delayed: count?.delayed ?? 0,
          failed: count?.failed ?? 0,
          lagMs: count?.oldestWaitingAt
            ? Math.max(0, now.getTime() - count.oldestWaitingAt.getTime())
            : 0,
          ...(mark?.lastRunAt ? { lastRunAt: mark.lastRunAt } : {}),
          ...(mark?.lastSuccessAt ? { lastSuccessAt: mark.lastSuccessAt } : {}),
        });
      }),
    );
  };

  const listFailed = async (limit: number) => {
    const rows = await db
      .select()
      .from(runs)
      .where(eq(runs.status, "failed"))
      .orderBy(asc(runs.failedAt), asc(runs.createdAt))
      .limit(limit);
    return Object.freeze(rows.map((row) => toRun(row)));
  };

  const retry = async (runId: string, now: Date) => {
    const [row] = await db
      .update(runs)
      .set({ status: "waiting", availableAt: now, failedAt: null })
      .where(and(eq(runs.id, runId), eq(runs.status, "failed")))
      .returning();
    return row ? toRun(row) : undefined;
  };

  const discard = async (runId: string, reason: string, now: Date) => {
    const [row] = await db
      .update(runs)
      .set({ status: "discarded", discardedAt: now, discardReason: reason })
      .where(and(eq(runs.id, runId), eq(runs.status, "failed")))
      .returning();
    return row ? toRun(row) : undefined;
  };

  const cleanup = async (
    retention: ReadonlyMap<string, JobRetention>,
    fallback: JobRetention,
    now: Date,
  ) => {
    let completedDeleted = 0;
    let deadLetteredDeleted = 0;
    const known = [...retention.keys()];
    const policies: { readonly scope: SQL | undefined; readonly policy: JobRetention }[] = [
      ...[...retention].map(([jobId, policy]) => ({ scope: eq(runs.jobId, jobId), policy })),
      // Runs of jobs no longer declared fall back to the default retention.
      { scope: known.length > 0 ? notInArray(runs.jobId, known) : undefined, policy: fallback },
    ];
    for (const { scope, policy } of policies) {
      const completed = await db
        .delete(runs)
        .where(
          and(
            scope,
            eq(runs.status, "completed"),
            lte(runs.completedAt, new Date(now.getTime() - policy.completedMs)),
          ),
        )
        .returning({ id: runs.id });
      completedDeleted += completed.length;
      const deadLettered = await db
        .delete(runs)
        .where(
          and(
            scope,
            or(
              and(
                eq(runs.status, "failed"),
                lte(runs.failedAt, new Date(now.getTime() - policy.deadLetteredMs)),
              ),
              and(
                eq(runs.status, "discarded"),
                lte(runs.discardedAt, new Date(now.getTime() - policy.deadLetteredMs)),
              ),
            ),
          ),
        )
        .returning({ id: runs.id });
      deadLetteredDeleted += deadLettered.length;
    }
    return Object.freeze({ completedDeleted, deadLetteredDeleted });
  };

  const listRuns = async (query: JobRunQuery, now: Date) => {
    const conditions: (SQL | undefined)[] = [];
    if (query.jobId !== undefined) conditions.push(eq(runs.jobId, query.jobId));
    if (query.status === "delayed") {
      conditions.push(eq(runs.status, "waiting"), gt(runs.availableAt, now));
    } else if (query.status === "waiting") {
      conditions.push(eq(runs.status, "waiting"), lte(runs.availableAt, now));
    } else if (query.status !== undefined) {
      conditions.push(eq(runs.status, query.status));
    }
    const rows = await db
      .select()
      .from(runs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(query.limit);
    return Object.freeze(rows.map((row) => toRun(row, now)));
  };

  const getRun = async (runId: string, now: Date) => {
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    return row ? toRun(row, now) : undefined;
  };

  const listSchedules = async () => {
    const rows = await db
      .select()
      .from(state)
      .where(isNotNull(state.trigger))
      .orderBy(asc(state.jobId));
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          jobId: row.jobId,
          trigger: row.trigger as JobScheduleTrigger | JobIntervalTrigger,
          ...(row.nextAt ? { nextAt: row.nextAt } : {}),
        }),
      ),
    );
  };

  const listPaused = async (): Promise<readonly string[]> => {
    if (!control) return Object.freeze([]);
    const rows = await db
      .select({ jobId: control.jobId })
      .from(control)
      .where(isNotNull(control.pausedAt))
      .orderBy(asc(control.jobId));
    return Object.freeze(rows.map((row) => row.jobId));
  };

  const setPaused = control
    ? async (jobId: string, paused: boolean, now: Date) => {
        await db
          .insert(control)
          .values({ jobId, pausedAt: paused ? now : null, updatedAt: now })
          .onConflictDoUpdate({
            target: control.jobId,
            set: { pausedAt: paused ? now : null, updatedAt: now },
          });
      }
    : undefined;

  return Object.freeze({
    insert,
    findDeduplicated,
    countQueued,
    claim,
    heartbeat,
    complete,
    reschedule,
    fail,
    upsertSchedule,
    deleteSchedule,
    tick,
    health,
    listFailed,
    retry,
    discard,
    cleanup,
    listRuns,
    getRun,
    listSchedules,
    listPaused,
    ...(setPaused ? { setPaused } : {}),
  });
}

function toRun(row: ShipJobRunsTable["$inferSelect"], now?: Date): JobRun {
  const history: readonly JobAttemptFailure[] = Object.freeze(
    (row.history ?? []).map((item) =>
      Object.freeze({ attempt: item.attempt, error: item.error, at: new Date(item.at) }),
    ),
  );
  return Object.freeze({
    runId: row.id,
    jobId: row.jobId,
    input: row.input,
    ...(row.key !== null ? { key: row.key } : {}),
    ...(row.dedupeKey !== null ? { dedupeKey: row.dedupeKey } : {}),
    status:
      now && row.status === "waiting" && row.availableAt.getTime() > now.getTime()
        ? "delayed"
        : (row.status as JobRunStatus),
    attempts: row.attempts,
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    history,
    createdAt: row.createdAt,
    availableAt: row.availableAt,
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.failedAt ? { failedAt: row.failedAt } : {}),
    ...(row.discardedAt ? { discardedAt: row.discardedAt } : {}),
    ...(row.discardReason !== null ? { discardReason: row.discardReason } : {}),
  });
}

function assertTableName(name: string): void {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new DrizzleRepositoryError(
      "SHIP_DRIZZLE_JOB_BACKEND_INVALID",
      `job table name must be a lowercase identifier; received ${JSON.stringify(name)}`,
      { field: "table" },
    );
  }
}
