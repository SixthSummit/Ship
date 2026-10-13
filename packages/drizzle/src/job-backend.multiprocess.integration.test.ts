import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing/postgres";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildWorker, spawnChildWorker } from "./__fixtures__/children.js";
import {
  createFixtureRuntime,
  type FixtureEvent,
  fixtureDeliveries,
  fixtureEvents,
  fixtureRuns,
  fixtureSchema,
} from "./__fixtures__/job-fixture-app.js";

interface Interval {
  readonly worker: string;
  readonly start: number;
  readonly end: number;
}

function intervals(events: readonly FixtureEvent[], key: string): Interval[] {
  const starts = new Map<string, FixtureEvent>();
  const result: Interval[] = [];
  for (const event of events.filter((item) => item.job === "fixture.serial" && item.key === key)) {
    if (event.phase === "start") {
      starts.set(event.runId, event);
      continue;
    }
    const start = starts.get(event.runId);
    if (start) result.push({ worker: event.worker, start: start.at, end: event.at });
  }
  return result.sort((left, right) => left.start - right.start);
}

function overlaps(left: Interval, right: Interval): boolean {
  return left.start < right.end && right.start < left.end;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

describe("two worker processes on one PostgreSQL", () => {
  let postgres: PostgresTestDb<typeof fixtureSchema>;
  let children: ChildWorker[] = [];
  let api: Awaited<ReturnType<typeof createFixtureRuntime>>;

  // Ordered by insertion id: the interval builder pairs each end with the start
  // it has already seen, and an unordered scan can return an end row first.
  const events = async () =>
    (await postgres.db.select().from(fixtureEvents).orderBy(asc(fixtureEvents.id))).map(
      (row): FixtureEvent => ({
        job: row.job,
        worker: row.worker,
        key: row.key,
        runId: row.runId,
        phase: row.phase as "start" | "end",
        at: row.at,
      }),
    );

  beforeAll(async () => {
    postgres = await setupPostgresTestDb(fixtureSchema);
    children = ["worker-a", "worker-b"].map((name) =>
      spawnChildWorker("job-worker-child.ts", {
        DATABASE_URL: postgres.connectionString,
        WORKER_NAME: name,
        HOLD_MS: "150",
      }),
    );
    await Promise.all(children.map((child) => child.ready));
    api = await createFixtureRuntime({
      databaseUrl: postgres.connectionString,
      workerName: "api",
      mode: "api",
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(children.map((child) => child.stop()));
    await api?.stop();
    await postgres?.cleanup();
  }, 60_000);

  it("never lets two processes own one (jobId, key) run while other keys proceed concurrently", async () => {
    const perKey = 6;
    for (let index = 0; index < perKey; index += 1) {
      for (const tenantId of ["acme", "beta"]) {
        const result = await api.backend.enqueue("fixture.serial", { tenantId, index });
        expect(result).toMatchObject({ accepted: true });
      }
    }
    // Wait on the backend's own signal: a handler's end event precedes the
    // completion write, so the run ledger, not the event log, says when it is done.
    const serialRuns = async () =>
      postgres.db.select().from(fixtureRuns).where(eq(fixtureRuns.jobId, "fixture.serial"));
    await waitFor(
      async () => {
        const rows = await serialRuns();
        return rows.length === perKey * 2 && rows.every((row) => row.status === "completed");
      },
      "every serial run to be recorded completed",
      60_000,
    );
    const all = await events();
    const acme = intervals(all, "acme");
    const beta = intervals(all, "beta");
    expect(acme).toHaveLength(perKey);
    expect(beta).toHaveLength(perKey);
    for (const runs of [acme, beta]) {
      for (let index = 1; index < runs.length; index += 1) {
        const previous = runs[index - 1] as Interval;
        const current = runs[index] as Interval;
        expect(current.start).toBeGreaterThanOrEqual(previous.end);
      }
    }
    expect(acme.some((left) => beta.some((right) => overlaps(left, right)))).toBe(true);
    expect(new Set([...acme, ...beta].map((run) => run.worker))).toEqual(
      new Set(["worker-a", "worker-b"]),
    );
    const rows = await serialRuns();
    expect(rows).toHaveLength(perKey * 2);
    expect(rows.every((row) => row.status === "completed" && row.claimToken === null)).toBe(true);
  }, 90_000);

  it("deduplicates scheduler ticks across processes by durable run identity", async () => {
    await waitFor(
      async () => (await events()).filter((event) => event.job === "fixture.tick").length >= 3,
      "at least three scheduled ticks",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const ticks = (await events()).filter((event) => event.job === "fixture.tick");
    const runIds = ticks.map((event) => event.runId);
    expect(new Set(runIds).size).toBe(runIds.length);
    // Both processes reconciled the same schedule row. The durable run identity is
    // `<jobId>/<occurrence>`, so every executed tick must map to exactly one run row and the
    // occurrences must advance by the declared interval; wall-clock spacing between handler
    // observations is not asserted because the parallel lane can compress it.
    const tickRows = await postgres.db
      .select()
      .from(fixtureRuns)
      .where(eq(fixtureRuns.jobId, "fixture.tick"));
    const rowIds = new Set(tickRows.map((row) => row.id));
    for (const runId of runIds) expect(rowIds.has(runId)).toBe(true);
    const occurrences = tickRows
      .map((row) => row.availableAt.getTime())
      .sort((left, right) => left - right);
    for (let index = 1; index < occurrences.length; index += 1) {
      expect((occurrences[index] as number) - (occurrences[index - 1] as number)).toBe(400);
    }
    const health = await api.backend.health(new Date());
    expect(
      health.jobs.find((entry) => entry.jobId === "fixture.tick")?.lastSuccessAt,
    ).toBeDefined();
  }, 60_000);
});

describe("crash after external success before completion is recorded", () => {
  let postgres: PostgresTestDb<typeof fixtureSchema>;

  beforeAll(async () => {
    postgres = await setupPostgresTestDb(fixtureSchema);
  }, 120_000);

  afterAll(async () => {
    await postgres?.cleanup();
  }, 60_000);

  it("re-delivers once the lease expires (at-least-once), then records completion", async () => {
    const environment = { DATABASE_URL: postgres.connectionString };
    const api = await createFixtureRuntime({
      databaseUrl: postgres.connectionString,
      workerName: "api",
      mode: "api",
    });
    const crashing = spawnChildWorker("job-worker-child.ts", {
      ...environment,
      WORKER_NAME: "crashing",
      CRASH_AT: "after-effect",
    });
    await crashing.ready;
    const accepted = await api.backend.enqueue("fixture.effect", { key: "after-effect" });
    expect(accepted).toMatchObject({ accepted: true });
    if (!accepted.accepted) throw new Error("unreachable");
    expect(await crashing.exited).toBe(3);
    const delivered = async () =>
      (
        await postgres.db
          .select()
          .from(fixtureDeliveries)
          .where(eq(fixtureDeliveries.key, "after-effect"))
      ).map((row) => row.worker);
    expect(await delivered()).toEqual(["crashing"]);
    const [afterCrash] = await postgres.db
      .select()
      .from(fixtureRuns)
      .where(eq(fixtureRuns.id, accepted.runId));
    expect(afterCrash).toMatchObject({ status: "active", attempts: 1 });

    const recovering = spawnChildWorker("job-worker-child.ts", {
      ...environment,
      WORKER_NAME: "recovering",
      CRASH_AT: "none",
    });
    await recovering.ready;
    await waitFor(
      async () =>
        (await postgres.db.select().from(fixtureRuns).where(eq(fixtureRuns.id, accepted.runId)))[0]
          ?.status === "completed",
      "lease expiry and recovery",
      45_000,
    );
    const [recovered] = await postgres.db
      .select()
      .from(fixtureRuns)
      .where(eq(fixtureRuns.id, accepted.runId));
    expect(recovered).toMatchObject({ status: "completed", attempts: 2, claimToken: null });
    // The external effect happened twice: once before the crash, once on recovery.
    expect(await delivered()).toEqual(["crashing", "recovering"]);
    await recovering.stop();
    await api.stop();
  }, 120_000);
});
