import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { permission, publicAccess, systemAccess } from "./access.js";
import { humanActor, systemActor } from "./actor.js";
import { ApplicationCompilationError, compileApp, defineApp } from "./application.js";
import { dependency, effectDependency, unitOfWorkDependency } from "./dependency.js";
import { createExecutor, jobKey, OperationExecutionError } from "./executor.js";
import {
  type AnyJob,
  createJobEnqueuer,
  DEFAULT_JOB_LEASE_MS,
  defineJob,
  defineJobCleanup,
  defineJobManagement,
  describeJobOperation,
  InvalidJobDefinitionError,
  isJob,
  isJobBackend,
  isJobDependencyToken,
  isJobEnqueueDependencyToken,
  isLockProvider,
  JOB_BACKEND_ID,
  JOB_LOCK_PROVIDER_ID,
  JOBS_MANAGE_PERMISSION,
  type JobBackend,
  JobEnqueueError,
  type JobRun,
  jobBackendDependency,
  jobDependency,
  jobRunView,
  type LockLease,
  type LockProvider,
  lockProviderDependency,
  registerJobTriggerOperation,
} from "./job.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import { operationError, operationFailure } from "./operation-error.js";
import { defineOutbox, type OutboxBackend, outboxIntent } from "./outbox.js";
import { defineProvider, valueProvider } from "./provider.js";

interface Notifier {
  send(message: { readonly recipient: string }): Promise<void>;
}

const notifier = effectDependency<Notifier>("reports.notifier", { delivery: "immediate" });
const unitOfWork = unitOfWorkDependency<{ readonly records: { save(value: string): void } }>(
  "database.primary",
);
const payloadSchema = z.object({ tenantId: z.string().min(1), value: z.number().int() });

function fakeRun(overrides: Partial<JobRun> = {}): JobRun {
  return Object.freeze({
    runId: "run-1",
    jobId: "reports.digest",
    input: { tenantId: "acme", value: 1 },
    status: "failed" as const,
    attempts: 2,
    lastError: "Error: boom",
    history: [
      { attempt: 1, error: "Error: boom", at: new Date("2026-09-18T00:00:00.000Z") },
      { attempt: 2, error: "Error: boom", at: new Date("2026-09-18T00:01:00.000Z") },
    ],
    createdAt: new Date("2026-09-18T00:00:00.000Z"),
    availableAt: new Date("2026-09-18T00:00:00.000Z"),
    failedAt: new Date("2026-09-18T00:01:00.000Z"),
    ...overrides,
  });
}

function fakeBackend(overrides: Partial<JobBackend> = {}): JobBackend & {
  readonly enqueued: { jobId: string; input: unknown; options: unknown }[];
} {
  const enqueued: { jobId: string; input: unknown; options: unknown }[] = [];
  return {
    kind: "ship.job-backend",
    adapter: "fake",
    concurrencyBudget: { maxInFlight: 4, maxQueueDepth: 10 },
    enqueued,
    attach: () => undefined,
    enqueue: async (jobId, input, options) => {
      enqueued.push({ jobId, input, options });
      return { accepted: true, runId: `run-${enqueued.length}`, deduplicated: false };
    },
    schedule: async () => undefined,
    unschedule: async () => undefined,
    startWorkers: async () => 0,
    quit: async () => undefined,
    health: async () => ({
      jobs: [
        {
          jobId: "reports.digest",
          waiting: 1,
          active: 0,
          delayed: 0,
          failed: 2,
          lagMs: 250,
          lastRunAt: new Date("2026-09-18T00:00:00.000Z"),
        },
      ],
    }),
    listFailed: async () => [fakeRun()],
    retry: async (runId) => (runId === "run-1" ? fakeRun({ status: "waiting" }) : undefined),
    discard: async (runId, reason) =>
      runId === "run-1" ? fakeRun({ status: "discarded", discardReason: reason }) : undefined,
    cleanup: async () => ({ completedDeleted: 3, deadLetteredDeleted: 1 }),
    ...overrides,
  };
}

function fakeLockProvider(options: { readonly extend?: boolean } = {}) {
  const held = new Map<string, LockLease>();
  const calls: string[] = [];
  const provider: LockProvider = {
    kind: "ship.lock-provider",
    acquire: async (jobId, key, ttlMs) => {
      const id = `${jobId}:${key}`;
      calls.push(`acquire ${id}`);
      if (held.has(id)) return undefined;
      const lease = {
        jobId,
        key,
        token: `token-${calls.length}`,
        expiresAt: new Date(Date.now() + ttlMs),
      };
      held.set(id, lease);
      return lease;
    },
    release: async (lease) => {
      calls.push(`release ${lease.jobId}:${lease.key}`);
      held.delete(`${lease.jobId}:${lease.key}`);
    },
    ...(options.extend === false
      ? {}
      : {
          extend: async (lease: LockLease) => {
            calls.push(`extend ${lease.jobId}:${lease.key}`);
            return held.has(`${lease.jobId}:${lease.key}`);
          },
        }),
  };
  return { provider, held, calls };
}

function baseDefinition() {
  return {
    id: "reports.digest",
    input: payloadSchema,
    trigger: { kind: "enqueue" as const },
    concurrency: { mode: "parallel" as const },
    retry: { attempts: 3, backoff: { initialMs: 100 } },
    transaction: "none" as const,
    dependencies: {},
    handler: async ({ input }: { readonly input: z.infer<typeof payloadSchema> }) => ({
      digest: `${input.tenantId}:${input.value}`,
    }),
  };
}

function digestJob(overrides: Record<string, unknown> = {}) {
  return defineJob({ ...baseDefinition(), ...overrides } as never) as AnyJob;
}

describe("defineJob", () => {
  it("compiles a job into a system-access operation with a job transport", () => {
    const job = defineJob({
      ...baseDefinition(),
      trigger: { kind: "schedule", cron: "0 * * * *", tz: "UTC" },
      concurrency: { mode: "single-runner", key: (input) => input.tenantId, leaseMs: 5_000 },
      retention: { completedMs: 1_000, deadLetteredMs: 2_000 },
    });

    expect(job.kind).toBe("ship.operation");
    expect(job.access).toEqual(systemAccess());
    expect(Object.keys(job.input)).toEqual(["payload"]);
    expect(job.successStatus).toBe(200);
    expect(job.transport).toMatchObject({
      kind: "job",
      binding: "reports.digest",
      metadata: {
        trigger: { kind: "schedule", cron: "0 * * * *", tz: "UTC" },
        concurrency: { mode: "single-runner", max: 1, keyed: true, leaseMs: 5_000 },
        retry: { attempts: 3, backoff: { initialMs: 100 } },
        retention: { completedMs: 1_000, deadLetteredMs: 2_000 },
      },
    });
    expect(job.job).toMatchObject({
      id: "reports.digest",
      concurrency: { mode: "single-runner", max: 1, keyed: true, leaseMs: 5_000 },
      transaction: "none",
    });
    expect(typeof job.job.key).toBe("function");
    expect(isJob(job)).toBe(true);
    expect(isJob(defineOperation({ ...job, id: "reports.other" }))).toBe(false);
    expect(describeJobOperation(job)).toEqual({ role: "job", jobId: "reports.digest" });
    expect(Object.isFrozen(job.job)).toBe(true);
    expect(job.errors).toEqual([]);
  });

  it("names the module/id rule when a job or management prefix is not the owning module id", () => {
    const management = defineJobManagement({ prefix: "ops" });
    const job = defineJob({ ...baseDefinition(), id: "ops.digest" });
    const backend = fakeBackend();
    expect.assertions(3);
    try {
      compileApp({
        id: "jobs-fixture",
        modules: [
          defineModule({
            id: "reports",
            operations: [job, management.listFailed],
            providers: [valueProvider(jobBackendDependency(), backend)],
            imports: [],
            exports: [],
          }),
        ],
      });
    } catch (error) {
      const diagnostics = (error as ApplicationCompilationError).diagnostics.filter(
        (item) => item.code === "SHIP_MODULE_OPERATION_ID_MISMATCH",
      );
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.find((item) => item.operationId === "ops.digest")?.hint).toMatch(
        /Job ids are namespaced by the module that owns them/u,
      );
      expect(diagnostics.find((item) => item.operationId === "ops.list-failed")?.hint).toMatch(
        /defineJobManagement\(\{ prefix \}\) must use the owning module id: pass prefix "reports"/u,
      );
    }
  });

  it("accepts a zero retention meaning collect on the next cleanup sweep", () => {
    const job = defineJob({
      ...baseDefinition(),
      retention: { completedMs: 0, deadLetteredMs: 0 },
    });
    expect(job.job.retention).toEqual({ completedMs: 0, deadLetteredMs: 0 });
    expect(job.transport?.metadata).toMatchObject({
      retention: { completedMs: 0, deadLetteredMs: 0 },
    });
  });

  it("carries declared failures so a handler can refuse a run as a final outcome", async () => {
    const tenantRefused = operationError({
      code: "TENANT_REFUSED",
      status: 403,
      message: "Tenant refused",
    });
    const job = defineJob({
      ...baseDefinition(),
      errors: [tenantRefused],
      handler: async ({ input }) => {
        if (input.tenantId === "gamma") throw operationFailure(tenantRefused);
        return { digest: input.tenantId };
      },
    });
    expect(job.errors).toEqual([tenantRefused]);
    const app = compileApp({
      id: "jobs-api",
      modules: [
        defineModule({
          id: "reports",
          operations: [job],
          providers: [valueProvider(jobBackendDependency(), fakeBackend())],
          imports: [],
          exports: [],
        }),
      ],
    });
    const executor = createExecutor(app);
    const actor = systemActor({ id: "worker" });
    await expect(
      executor.run("reports.digest", { payload: { tenantId: "gamma", value: 1 } }, { actor }),
    ).resolves.toMatchObject({ ok: false, status: 403, error: { code: "TENANT_REFUSED" } });
    await expect(
      executor.run("reports.digest", { payload: { tenantId: "acme", value: 1 } }, { actor }),
    ).resolves.toMatchObject({ ok: true, data: { digest: "acme" } });
  });

  it("applies declaration defaults and projects http trigger access as JSON", () => {
    const job = defineJob({
      ...baseDefinition(),
      trigger: { kind: "http", access: permission("reports:trigger") },
      concurrency: { mode: "single-runner", reason: "the digest aggregates every tenant" },
    });

    expect(job.job.concurrency).toEqual({
      mode: "single-runner",
      max: 1,
      keyed: false,
      reason: "the digest aggregates every tenant",
      leaseMs: DEFAULT_JOB_LEASE_MS,
    });
    expect(job.transport.metadata.trigger).toEqual({
      kind: "http",
      access: { kind: "permissions", mode: "all", permissions: ["reports:trigger"] },
    });
    expect(JSON.parse(JSON.stringify(job.transport.metadata))).toEqual(job.transport.metadata);
    expect(
      defineJob({
        ...baseDefinition(),
        trigger: { kind: "http", access: publicAccess() },
      }).transport.metadata.trigger,
    ).toEqual({ kind: "http", access: { kind: "public" } });
  });

  it("wraps idempotency keys so they receive the payload", () => {
    const store = {
      kind: "ship.dependency" as const,
      id: "platform.idempotency",
      scope: "idempotency" as const,
    };
    const job = defineJob({
      ...baseDefinition(),
      idempotency: { key: (input) => input.tenantId, windowMs: 1_000, store },
    });
    expect(job.idempotency?.key({ payload: { tenantId: "acme", value: 1 } } as never)).toBe("acme");
    expect(job.idempotency?.windowMs).toBe(1_000);
  });

  it.each([
    ["non-object", null, "SHIP_JOB_DEFINITION_INVALID"],
    ["single segment id", { id: "digest" }, "SHIP_JOB_ID_INVALID"],
    ["input not a schema", { input: {} }, "SHIP_JOB_INPUT_INVALID"],
    ["unknown trigger", { trigger: { kind: "webhook" } }, "SHIP_JOB_TRIGGER_INVALID"],
    ["trigger not an object", { trigger: "schedule" }, "SHIP_JOB_TRIGGER_INVALID"],
    [
      "bad cron",
      { trigger: { kind: "schedule", cron: "hourly", tz: "UTC" } },
      "SHIP_JOB_TRIGGER_INVALID",
    ],
    [
      "schedule without tz",
      { trigger: { kind: "schedule", cron: "0 * * * *" } },
      "SHIP_JOB_SCHEDULE_TZ_REQUIRED",
    ],
    [
      "unknown tz",
      { trigger: { kind: "schedule", cron: "0 * * * *", tz: "Mars/Olympus" } },
      "SHIP_JOB_TRIGGER_INVALID",
    ],
    [
      "interval without everyMs",
      { trigger: { kind: "interval", everyMs: 0 } },
      "SHIP_JOB_TRIGGER_INVALID",
    ],
    ["http without access", { trigger: { kind: "http", access: {} } }, "SHIP_JOB_TRIGGER_INVALID"],
    ["concurrency missing", { concurrency: undefined }, "SHIP_JOB_CONCURRENCY_INVALID"],
    ["concurrency mode", { concurrency: { mode: "serial" } }, "SHIP_JOB_CONCURRENCY_INVALID"],
    [
      "concurrency max",
      { concurrency: { mode: "parallel", max: 0 } },
      "SHIP_JOB_CONCURRENCY_INVALID",
    ],
    [
      "concurrency key",
      { concurrency: { mode: "parallel", key: "tenant" } },
      "SHIP_JOB_CONCURRENCY_INVALID",
    ],
    [
      "concurrency reason",
      { concurrency: { mode: "parallel", reason: " " } },
      "SHIP_JOB_CONCURRENCY_INVALID",
    ],
    [
      "concurrency lease",
      { concurrency: { mode: "parallel", leaseMs: -1 } },
      "SHIP_JOB_CONCURRENCY_INVALID",
    ],
    [
      "keyless single-runner without reason",
      { concurrency: { mode: "single-runner" } },
      "SHIP_JOB_SINGLE_RUNNER_REASON_REQUIRED",
    ],
    ["retry missing", { retry: undefined }, "SHIP_JOB_RETRY_INVALID"],
    [
      "retry.attempts missing",
      { retry: { backoff: { initialMs: 1 } } },
      "SHIP_JOB_RETRY_ATTEMPTS_REQUIRED",
    ],
    [
      "retry.attempts zero",
      { retry: { attempts: 0, backoff: { initialMs: 1 } } },
      "SHIP_JOB_RETRY_INVALID",
    ],
    [
      "retry.backoff",
      { retry: { attempts: 1, backoff: { initialMs: -1 } } },
      "SHIP_JOB_RETRY_INVALID",
    ],
    [
      "retry.backoff multiplier",
      { retry: { attempts: 1, backoff: { initialMs: 1, multiplier: 0.5 } } },
      "SHIP_JOB_RETRY_INVALID",
    ],
    ["transaction", { transaction: "serializable" }, "SHIP_JOB_TRANSACTION_INVALID"],
    [
      "retention",
      { retention: { completedMs: -1, deadLetteredMs: 1 } },
      "SHIP_JOB_RETENTION_INVALID",
    ],
    [
      "retention fraction",
      { retention: { completedMs: 1.5, deadLetteredMs: 1 } },
      "SHIP_JOB_RETENTION_INVALID",
    ],
    ["idempotency", { idempotency: { key: () => "k" } }, "SHIP_JOB_IDEMPOTENCY_INVALID"],
    ["handler", { handler: "run" }, "SHIP_JOB_HANDLER_INVALID"],
    ["errors", { errors: "TENANT_ACCESS_DENIED" }, "SHIP_JOB_ERRORS_INVALID"],
  ])("rejects %s", (_label, overrides, code) => {
    expect.assertions(2);
    try {
      defineJob(
        overrides === null ? (null as never) : ({ ...baseDefinition(), ...overrides } as never),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidJobDefinitionError);
      expect((error as InvalidJobDefinitionError).code).toBe(code);
    }
  });

  it("creates job dependency tokens and guards them", () => {
    const job = digestJob();
    const token = jobDependency(job);
    expect(token).toMatchObject({ id: "reports.digest", scope: "job", role: "enqueue" });
    expect(isJobDependencyToken(token)).toBe(true);
    expect(isJobEnqueueDependencyToken(token)).toBe(true);
    expect(isJobEnqueueDependencyToken(jobBackendDependency())).toBe(false);
    expect(jobBackendDependency()).toEqual({
      kind: "ship.dependency",
      id: JOB_BACKEND_ID,
      scope: "job",
      role: "backend",
    });
    expect(lockProviderDependency()).toMatchObject({ id: JOB_LOCK_PROVIDER_ID, role: "lock" });
    expect(isJobDependencyToken(dependency("plain.token"))).toBe(false);
    expect(() => jobDependency({} as never)).toThrow(InvalidJobDefinitionError);
    expect(isJobBackend(fakeBackend())).toBe(true);
    expect(isJobBackend({ kind: "ship.job-backend" })).toBe(false);
    expect(isLockProvider(fakeLockProvider().provider)).toBe(true);
    expect(isLockProvider({ kind: "ship.lock-provider" })).toBe(false);
  });
});

describe("job enqueuer", () => {
  it("validates input against the job schema before reaching the backend", async () => {
    const backend = fakeBackend();
    const enqueuer = createJobEnqueuer(digestJob(), backend);

    await expect(
      enqueuer.enqueue({ tenantId: "acme", value: 2 }, { dedupeKey: "acme:2" }),
    ).resolves.toEqual({
      accepted: true,
      runId: "run-1",
      deduplicated: false,
    });
    expect(backend.enqueued).toEqual([
      {
        jobId: "reports.digest",
        input: { tenantId: "acme", value: 2 },
        options: { dedupeKey: "acme:2" },
      },
    ]);
    await expect(enqueuer.enqueue({ tenantId: "", value: 2 })).rejects.toMatchObject({
      name: "JobEnqueueError",
      code: "SHIP_JOB_INPUT_INVALID",
      jobId: "reports.digest",
      issues: [{ path: ["tenantId"] }],
    });
    await expect(
      enqueuer.enqueue({ tenantId: "acme", value: 2 }, { dedupeKey: "" }),
    ).rejects.toBeInstanceOf(JobEnqueueError);
    await expect(
      enqueuer.enqueue({ tenantId: "acme", value: 2 }, { delayMs: -5 }),
    ).rejects.toMatchObject({ code: "SHIP_JOB_ENQUEUE_OPTIONS_INVALID" });
  });
});

describe("compileApp job diagnostics", () => {
  const backendProvider = () => valueProvider(jobBackendDependency(), fakeBackend());
  const lockProvider = () => valueProvider(lockProviderDependency(), fakeLockProvider().provider);

  function moduleWith(
    operations: readonly AnyJob[] | readonly ReturnType<typeof defineOperation>[],
    providers: readonly ReturnType<typeof defineProvider>[] = [],
    id = "reports",
  ) {
    return defineModule({
      id,
      operations: operations as never,
      providers: providers as never,
      imports: [],
      exports: [],
    });
  }

  function codesOf(definition: Parameters<typeof compileApp>[0]): string[] {
    try {
      compileApp(definition);
      return [];
    } catch (error) {
      if (error instanceof ApplicationCompilationError) {
        return error.diagnostics.map((item) => item.code);
      }
      throw error;
    }
  }

  it("reports duplicate job ids", () => {
    const codes = codesOf({
      id: "jobs-api",
      modules: [moduleWith([digestJob()]), moduleWith([digestJob()], [], "reports-copy")],
    });
    expect(codes).toContain("SHIP_JOB_ID_DUPLICATE");
    expect(codes).toContain("SHIP_OPERATION_ID_DUPLICATE");
  });

  it("requires a lock provider for single-runner jobs", () => {
    const job = digestJob({
      concurrency: { mode: "single-runner", key: (input: { tenantId: string }) => input.tenantId },
    });
    expect(codesOf({ id: "jobs-api", modules: [moduleWith([job])] })).toEqual([
      "SHIP_JOB_LOCK_PROVIDER_MISSING",
    ]);
    expect(codesOf({ id: "jobs-api", modules: [moduleWith([job], [lockProvider()])] })).toEqual([]);
  });

  it("retains the keyless single-runner warning on the compiled application", () => {
    const job = digestJob({ concurrency: { mode: "single-runner", reason: "global digest" } });
    const app = compileApp({ id: "jobs-api", modules: [moduleWith([job], [lockProvider()])] });
    expect(app.diagnostics).toEqual([
      expect.objectContaining({
        code: "SHIP_JOB_SINGLE_RUNNER_UNKEYED",
        severity: "warning",
        operationId: "reports.digest",
        message: expect.stringContaining("global digest"),
      }),
    ]);
    expect(Object.isFrozen(app.diagnostics)).toBe(true);
  });

  it("rejects an http trigger that no transport operation binds", () => {
    const job = digestJob({ trigger: { kind: "http", access: permission("reports:trigger") } });
    expect(codesOf({ id: "jobs-api", modules: [moduleWith([job])] })).toEqual([
      "SHIP_JOB_HTTP_TRIGGER_UNBOUND",
    ]);

    const trigger = defineOperation({
      id: "reports.digest.trigger",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: permission("reports:trigger"),
      transaction: "none",
      dependencies: { jobs: jobBackendDependency() },
      handler: () => ({ ok: true as const }),
    });
    registerJobTriggerOperation(trigger, job);
    expect(describeJobOperation(trigger)).toEqual({ role: "trigger", jobId: "reports.digest" });
    const app = compileApp({
      id: "jobs-api",
      modules: [moduleWith([job, trigger] as never, [backendProvider()])],
    });
    expect(app.graph.jobs[0]?.operations.triggers).toEqual(["reports.digest.trigger"]);
    expect(app.graph.operations.find((item) => item.id === "reports.digest.trigger")?.job).toEqual([
      { role: "backend" },
      { role: "trigger", jobId: "reports.digest" },
    ]);
  });

  it("rejects jobs that bind the raw backend instead of declaring what they enqueue", () => {
    const job = digestJob({ dependencies: { jobs: jobBackendDependency() } });
    expect(codesOf({ id: "jobs-api", modules: [moduleWith([job], [backendProvider()])] })).toEqual([
      "SHIP_JOB_BACKEND_BINDING_FORBIDDEN",
    ]);
  });

  it("requires enqueued jobs to be composed and resolves them through the backend", () => {
    const child = digestJob({ id: "reports.render" });
    const parent = digestJob({ dependencies: { render: jobDependency(child as never) } });
    expect(codesOf({ id: "jobs-api", modules: [moduleWith([parent])] })).toEqual([
      "SHIP_JOB_DEPENDENCY_MISSING",
      "SHIP_PROVIDER_MISSING",
    ]);
    const app = compileApp({
      id: "jobs-api",
      modules: [moduleWith([parent, child], [backendProvider()])],
    });
    expect(
      app.graph.jobs.map((item) => [item.id, item.enqueues, item.operations.enqueuedBy]),
    ).toEqual([
      ["reports.digest", ["reports.render"], []],
      ["reports.render", [], ["reports.digest"]],
    ]);
    expect(app.graph.operations.find((item) => item.id === "reports.digest")?.dependencies).toEqual(
      [
        {
          name: "render",
          providerId: "reports.render",
          scope: "job",
          role: "enqueue",
          jobId: "reports.render",
        },
      ],
    );
  });

  it("enforces module import and export rules through the backend provider id", () => {
    const child = digestJob({ id: "reports.render" });
    const parent = digestJob({ dependencies: { render: jobDependency(child as never) } });
    const platform = defineModule({
      id: "platform",
      operations: [],
      providers: [backendProvider()],
      imports: [],
      exports: [],
    });
    expect(codesOf({ id: "jobs-api", modules: [platform, moduleWith([parent, child])] })).toEqual([
      "SHIP_MODULE_IMPORT_REQUIRED",
    ]);
    const importing = defineModule({
      id: "reports",
      operations: [parent, child],
      providers: [],
      imports: ["platform"],
      exports: [],
    });
    expect(codesOf({ id: "jobs-api", modules: [platform, importing] })).toEqual([
      "SHIP_PROVIDER_NOT_EXPORTED",
    ]);
  });

  it("requires singleton backend and lock providers and keeps job tokens off providers", () => {
    const backend = defineProvider({
      token: jobBackendDependency(),
      dependencies: {},
      lifetime: "operation",
      create: () => fakeBackend(),
    });
    const lock = defineProvider({
      token: lockProviderDependency(),
      dependencies: {},
      lifetime: "operation",
      create: () => fakeLockProvider().provider,
    });
    const hidden = defineProvider({
      token: dependency<unknown>("reports.helper"),
      dependencies: { jobs: jobBackendDependency() },
      lifetime: "operation",
      create: () => ({}),
    });
    expect(codesOf({ id: "jobs-api", modules: [moduleWith([], [backend, lock, hidden])] })).toEqual(
      [
        "SHIP_JOB_BACKEND_PROVIDER_LIFETIME_INVALID",
        "SHIP_JOB_LOCK_PROVIDER_LIFETIME_INVALID",
        "SHIP_PROVIDER_JOB_FORBIDDEN",
      ],
    );
  });

  it("rejects an immediate effect on a transactional job", () => {
    const job = digestJob({
      transaction: "write",
      dependencies: { tx: unitOfWork, notifier },
      effects: [notifier],
    });
    const codes = codesOf({
      id: "jobs-api",
      modules: [
        moduleWith(
          [job],
          [
            valueProvider(unitOfWork, {
              kind: "ship.unit-of-work",
              id: "database.primary",
              run: async () => undefined,
            } as never),
            valueProvider(notifier, { send: async () => undefined }),
          ],
        ),
      ],
    });
    expect(codes).toEqual(["SHIP_OPERATION_EFFECT_TRANSACTION_FORBIDDEN"]);
  });

  it("validates the runtime declaration and projects it", () => {
    expect(() =>
      defineApp({ id: "jobs-api", modules: [], runtime: { workers: { mode: "cron" as never } } }),
    ).toThrow(ApplicationCompilationError);
    expect(() =>
      defineApp({ id: "jobs-api", modules: [], runtime: { workers: { mode: "all", budget: 0 } } }),
    ).toThrow(ApplicationCompilationError);
    expect(() => defineApp({ id: "jobs-api", modules: [], runtime: "worker" as never })).toThrow(
      ApplicationCompilationError,
    );
    expect(defineApp({ id: "jobs-api", modules: [] }).runtime).toEqual({});
    expect(
      defineApp({
        id: "jobs-api",
        modules: [],
        runtime: { workers: { mode: "worker", budget: 4 } },
      }).runtime,
    ).toEqual({ workers: { mode: "worker", budget: 4 } });
  });

  it("projects jobs, triggers, retention and provider scopes into the graph", () => {
    const job = defineJob({
      ...baseDefinition(),
      trigger: { kind: "interval", everyMs: 60_000 },
      concurrency: { mode: "single-runner", key: (input) => input.tenantId, max: 2 },
      retention: { completedMs: 10, deadLetteredMs: 20 },
      dependencies: { notifier },
      effects: [notifier],
    });
    const app = compileApp({
      id: "jobs-api",
      modules: [
        moduleWith(
          [job as never],
          [
            backendProvider(),
            lockProvider(),
            valueProvider(notifier, { send: async () => undefined }),
          ],
        ),
      ],
    });
    expect(app.graph.jobs).toEqual([
      {
        id: "reports.digest",
        moduleId: "reports",
        trigger: { kind: "interval", everyMs: 60_000 },
        concurrency: { mode: "single-runner", max: 2, keyed: true, leaseMs: DEFAULT_JOB_LEASE_MS },
        retry: { attempts: 3, backoff: { initialMs: 100 } },
        retention: { completedMs: 10, deadLetteredMs: 20 },
        transaction: "none",
        effects: ["reports.notifier"],
        enqueues: [],
        operations: { triggers: [], enqueuedBy: [] },
      },
    ]);
    expect(app.graph.providers.map((item) => [item.id, item.scope])).toEqual([
      ["reports.notifier", "effect"],
      ["ship.jobs", "job"],
      ["ship.jobs.lock", "job"],
    ]);
    expect(app.graph.operations[0]).toMatchObject({
      id: "reports.digest",
      access: { kind: "system" },
      transport: { kind: "job", binding: "reports.digest" },
      job: [{ role: "job", jobId: "reports.digest" }],
    });
    expect(JSON.parse(JSON.stringify(app.graph)).jobs).toEqual(app.graph.jobs);
  });
});

describe("executor job semantics", () => {
  const actor = systemActor({ id: "ship.jobs.test" });

  function application(job: AnyJob, lock = fakeLockProvider()) {
    const module = defineModule({
      id: "reports",
      operations: [job],
      providers: [valueProvider(lockProviderDependency(), lock.provider)],
      imports: [],
      exports: [],
    });
    return { app: defineApp({ id: "jobs-api", modules: [module] }), lock };
  }

  it("runs a job as a system actor and rejects other kinds", async () => {
    const { app } = application(digestJob());
    const executor = createExecutor(app);
    await expect(
      executor.run("reports.digest", { payload: { tenantId: "acme", value: 3 } }, { actor }),
    ).resolves.toMatchObject({ ok: true, status: 200, data: { digest: "acme:3" } });
    await expect(
      executor.run(
        "reports.digest",
        { payload: { tenantId: "acme", value: 3 } },
        { actor: humanActor({ id: "person" }) },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: { details: { requiredActorKind: "system" } },
    });
    await expect(
      executor.run("reports.digest", { payload: { tenantId: "", value: 3 } }, { actor }),
    ).resolves.toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_ERROR" } });
  });

  it("takes and releases a per-key lease for single-runner jobs", async () => {
    const job = digestJob({
      concurrency: {
        mode: "single-runner",
        key: (input: { tenantId: string }) => input.tenantId,
        leaseMs: 300,
      },
    });
    const { app, lock } = application(job);
    const executor = createExecutor(app);

    const result = await executor.run(
      "reports.digest",
      { payload: { tenantId: "acme", value: 1 } },
      { actor },
    );

    expect(result.ok).toBe(true);
    expect(lock.calls).toEqual(["acquire reports.digest:acme", "release reports.digest:acme"]);
    expect(lock.held.size).toBe(0);
  });

  it("reports JOB_LOCK_HELD when another runner owns the key and still runs other keys", async () => {
    const job = digestJob({
      concurrency: { mode: "single-runner", key: (input: { tenantId: string }) => input.tenantId },
    });
    const { app, lock } = application(job);
    const executor = createExecutor(app);
    await lock.provider.acquire("reports.digest", "acme", 1_000);

    await expect(
      executor.run("reports.digest", { payload: { tenantId: "acme", value: 1 } }, { actor }),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "JOB_LOCK_HELD", details: { jobId: "reports.digest", key: "acme" } },
    });
    await expect(
      executor.run("reports.digest", { payload: { tenantId: "beta", value: 1 } }, { actor }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("releases the lease when the handler fails", async () => {
    const job = digestJob({
      concurrency: { mode: "single-runner", reason: "global" },
      handler: async () => {
        throw new Error("boom");
      },
    });
    const { app, lock } = application(job);
    await expect(
      createExecutor(app).run(
        "reports.digest",
        { payload: { tenantId: "acme", value: 1 } },
        { actor },
      ),
    ).rejects.toBeInstanceOf(OperationExecutionError);
    expect(lock.calls).toEqual(["acquire reports.digest:", "release reports.digest:"]);
  });

  describe("lease heartbeat", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("extends the lease while the handler runs and stops afterwards", async () => {
      let finish: () => void = () => undefined;
      const job = digestJob({
        concurrency: { mode: "single-runner", reason: "global", leaseMs: 300 },
        handler: () =>
          new Promise<{ done: true }>((resolve) => {
            finish = () => resolve({ done: true });
          }),
      });
      const { app, lock } = application(job);
      const pending = createExecutor(app).run(
        "reports.digest",
        { payload: { tenantId: "acme", value: 1 } },
        { actor },
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(lock.calls.filter((call) => call.startsWith("extend"))).toHaveLength(2);
      finish();
      await expect(pending).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lock.calls.filter((call) => call.startsWith("extend"))).toHaveLength(2);
    });

    it("runs without a heartbeat when the provider cannot extend", async () => {
      const job = digestJob({
        concurrency: { mode: "single-runner", reason: "global", leaseMs: 300 },
      });
      const { app, lock } = application(job, fakeLockProvider({ extend: false }));
      await expect(
        createExecutor(app).run(
          "reports.digest",
          { payload: { tenantId: "acme", value: 1 } },
          { actor },
        ),
      ).resolves.toMatchObject({ ok: true });
      expect(lock.calls).toEqual(["acquire reports.digest:", "release reports.digest:"]);
    });
  });

  it("rejects invalid key functions and lock providers with stable codes", async () => {
    const throwing = digestJob({
      concurrency: {
        mode: "single-runner",
        key: () => {
          throw new Error("no key");
        },
      },
    });
    await expect(
      createExecutor(application(throwing).app).run(
        "reports.digest",
        { payload: { tenantId: "acme", value: 1 } },
        { actor },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_JOB_KEY_INVALID" });

    const empty = digestJob({ concurrency: { mode: "single-runner", key: () => "" } });
    await expect(
      createExecutor(application(empty).app).run(
        "reports.digest",
        { payload: { tenantId: "acme", value: 1 } },
        { actor },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_JOB_KEY_INVALID" });
    expect(jobKey(defineOperation({ ...digestJob(), id: "plain.op" }), {})).toBe("");

    const keyed = digestJob({ concurrency: { mode: "single-runner", reason: "global" } });
    const broken = defineModule({
      id: "reports",
      operations: [keyed],
      providers: [valueProvider(lockProviderDependency(), { kind: "not-a-lock" } as never)],
      imports: [],
      exports: [],
    });
    await expect(
      createExecutor(defineApp({ id: "jobs-api", modules: [broken] })).run(
        "reports.digest",
        { payload: { tenantId: "acme", value: 1 } },
        { actor },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_JOB_LOCK_PROVIDER_INVALID" });
  });

  it("resolves enqueuers, the raw backend and the lock provider from bindings", async () => {
    const child = digestJob({ id: "reports.render" });
    const parent = digestJob({
      dependencies: { render: jobDependency(child as never) },
      handler: async ({
        input,
        services,
      }: {
        input: { tenantId: string; value: number };
        services: { render: { enqueue(input: unknown): Promise<unknown> } };
      }) => services.render.enqueue({ tenantId: input.tenantId, value: input.value + 1 }),
    });
    const tooling = defineOperation({
      id: "reports.tooling",
      input: {},
      output: { 200: z.object({ adapter: z.string(), lock: z.boolean() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { jobs: jobBackendDependency(), lock: lockProviderDependency() },
      handler: ({ services }) => ({
        adapter: services.jobs.adapter,
        lock: isLockProvider(services.lock),
      }),
    });
    const backend = fakeBackend();
    const app = defineApp({
      id: "jobs-api",
      modules: [
        defineModule({
          id: "reports",
          operations: [parent, child, tooling],
          providers: [
            valueProvider(jobBackendDependency(), backend),
            valueProvider(lockProviderDependency(), fakeLockProvider().provider),
          ],
          imports: [],
          exports: [],
        }),
      ],
    });
    const executor = createExecutor(app);
    await expect(
      executor.run("reports.digest", { payload: { tenantId: "acme", value: 1 } }, { actor }),
    ).resolves.toMatchObject({ ok: true, data: { accepted: true, runId: "run-1" } });
    expect(backend.enqueued).toEqual([
      { jobId: "reports.render", input: { tenantId: "acme", value: 2 }, options: {} },
    ]);
    await expect(executor.run("reports.tooling", {})).resolves.toMatchObject({
      ok: true,
      data: { adapter: "fake", lock: true },
    });
  });

  it("fails clearly when the bound backend is not a job backend", async () => {
    const child = digestJob({ id: "reports.render" });
    const parent = digestJob({ dependencies: { render: jobDependency(child as never) } });
    const app = defineApp({
      id: "jobs-api",
      modules: [
        defineModule({
          id: "reports",
          operations: [parent, child],
          providers: [valueProvider(jobBackendDependency(), { kind: "nope" } as never)],
          imports: [],
          exports: [],
        }),
      ],
    });
    await expect(
      createExecutor(app).run(
        "reports.digest",
        { payload: { tenantId: "acme", value: 1 } },
        { actor },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_JOB_BACKEND_INVALID" });
  });
});

describe("defineJobManagement", () => {
  const admin = humanActor({ id: "admin", permissions: [JOBS_MANAGE_PERMISSION] });
  const viewer = humanActor({ id: "viewer", permissions: ["reports:read"] });

  function application(backend: JobBackend = fakeBackend()) {
    const management = defineJobManagement({ clock: () => new Date("2026-09-18T12:00:00.000Z") });
    const module = defineModule({
      id: "jobs",
      operations: management.operations,
      providers: [valueProvider(jobBackendDependency(), backend)],
      imports: [],
      exports: [],
    });
    return {
      management,
      executor: createExecutor(defineApp({ id: "jobs-api", modules: [module] })),
    };
  }

  it("generates the four management operations behind the manage permission", async () => {
    const { management, executor } = application();
    expect(management.operations.map((item) => item.id)).toEqual([
      "jobs.list-failed",
      "jobs.retry",
      "jobs.discard",
      "jobs.health",
    ]);
    expect(management.listFailed.access).toEqual(permission(JOBS_MANAGE_PERMISSION));
    expect(describeJobOperation(management.retry)).toEqual({ role: "management", action: "retry" });

    for (const [id, input] of [
      ["jobs.list-failed", { query: {} }],
      ["jobs.retry", { body: { runId: "run-1" } }],
      ["jobs.discard", { body: { runId: "run-1", reason: "stale" } }],
      ["jobs.health", {}],
    ] as const) {
      await expect(executor.run(id, input as never, { actor: viewer })).resolves.toMatchObject({
        ok: false,
        status: 403,
      });
    }

    const listed = await executor.run("jobs.list-failed", { query: {} }, { actor: admin });
    expect(listed).toMatchObject({
      ok: true,
      data: {
        runs: [
          {
            runId: "run-1",
            status: "failed",
            attempts: 2,
            history: [
              { attempt: 1, error: "Error: boom", at: "2026-09-18T00:00:00.000Z" },
              { attempt: 2, error: "Error: boom", at: "2026-09-18T00:01:00.000Z" },
            ],
            failedAt: "2026-09-18T00:01:00.000Z",
          },
        ],
      },
    });
    await expect(
      executor.run("jobs.retry", { body: { runId: "run-1" } }, { actor: admin }),
    ).resolves.toMatchObject({ ok: true, data: { run: { status: "waiting" } } });
    await expect(
      executor.run("jobs.retry", { body: { runId: "missing" } }, { actor: admin }),
    ).resolves.toMatchObject({ ok: false, status: 404, error: { code: "JOB_RUN_NOT_FOUND" } });
    await expect(
      executor.run("jobs.discard", { body: { runId: "run-1", reason: "stale" } }, { actor: admin }),
    ).resolves.toMatchObject({
      ok: true,
      data: { run: { status: "discarded", discardReason: "stale" } },
    });
    await expect(
      executor.run(
        "jobs.discard",
        { body: { runId: "missing", reason: "stale" } },
        { actor: admin },
      ),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(executor.run("jobs.health", {}, { actor: admin })).resolves.toMatchObject({
      ok: true,
      data: {
        jobs: [
          {
            jobId: "reports.digest",
            waiting: 1,
            failed: 2,
            lagMs: 250,
            lastRunAt: "2026-09-18T00:00:00.000Z",
          },
        ],
      },
    });
  });

  it("honors a custom prefix and validates options", () => {
    expect(defineJobManagement({ prefix: "ops" }).health.id).toBe("ops.health");
    expect(() => defineJobManagement({ prefix: "Ops" })).toThrow(InvalidJobDefinitionError);
    expect(() => defineJobManagement({ clock: "now" } as never)).toThrow(InvalidJobDefinitionError);
    expect(() => defineJobManagement(null as never)).toThrow(InvalidJobDefinitionError);
  });

  it("projects run views with every optional field", () => {
    expect(
      jobRunView(
        fakeRun({
          key: "acme",
          dedupeKey: "d",
          startedAt: new Date("2026-09-18T00:00:30.000Z"),
          completedAt: new Date("2026-09-18T00:00:40.000Z"),
          discardedAt: new Date("2026-09-18T00:00:50.000Z"),
          discardReason: "gone",
        }),
      ),
    ).toMatchObject({
      key: "acme",
      dedupeKey: "d",
      startedAt: "2026-09-18T00:00:30.000Z",
      completedAt: "2026-09-18T00:00:40.000Z",
      discardedAt: "2026-09-18T00:00:50.000Z",
      discardReason: "gone",
    });
  });
});

describe("defineJobCleanup", () => {
  const outbox = defineOutbox({
    id: "reports.outbox",
    retention: { completedMs: 100, deadLetteredMs: 200 },
    intents: {
      notify: outboxIntent({
        payload: z.object({ recipient: z.string() }),
        effect: notifier,
        perform: ({ effect, payload }) => effect.send(payload),
      }),
    },
  });

  it("sweeps job runs and declared outboxes on one keyed single-runner schedule", async () => {
    const outboxCleanup = vi.fn(async () => ({ completedDeleted: 2, deadLetteredDeleted: 0 }));
    const unused = async () => {
      throw new Error("not used by cleanup");
    };
    const outboxBackend = {
      kind: "ship.outbox-backend",
      outboxId: "reports.outbox",
      record: unused,
      claimDue: unused,
      claimUnknownDue: unused,
      complete: unused,
      fail: unused,
      listDeadLettered: unused,
      retry: unused,
      discard: unused,
      health: unused,
      cleanup: outboxCleanup,
    } as unknown as OutboxBackend;
    const backend = fakeBackend();
    const cleanup = defineJobCleanup({
      trigger: { kind: "schedule", cron: "0 3 * * *", tz: "UTC" },
      outboxes: [outbox],
      clock: () => new Date("2026-09-18T03:00:00.000Z"),
    });
    expect(cleanup.id).toBe("jobs.cleanup");
    expect(cleanup.job.concurrency).toMatchObject({ mode: "single-runner", keyed: true });
    expect(describeJobOperation(cleanup)).toEqual({
      role: "cleanup",
      jobId: "jobs.cleanup",
      outboxIds: ["reports.outbox"],
    });

    const lock = fakeLockProvider();
    const app = defineApp({
      id: "jobs-api",
      modules: [
        defineModule({
          id: "jobs",
          operations: [cleanup],
          providers: [
            valueProvider(jobBackendDependency(), backend),
            valueProvider(lockProviderDependency(), lock.provider),
            valueProvider(outbox.backend, outboxBackend),
          ],
          imports: [],
          exports: [],
        }),
      ],
    });
    expect(app.diagnostics).toEqual([]);
    expect(app.graph.operations[0]?.job).toEqual([{ role: "cleanup", jobId: "jobs.cleanup" }]);
    expect(app.graph.operations[0]?.outbox).toEqual([{ id: "reports.outbox", role: "cleanup" }]);
    expect(app.graph.outboxes[0]?.operations).toEqual({
      writers: [],
      dispatchers: [],
      cleanups: ["jobs.cleanup"],
      management: [],
    });

    await expect(
      createExecutor(app).run("jobs.cleanup", { payload: {} }, { actor: systemActor({ id: "w" }) }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        runs: { completedDeleted: 3, deadLetteredDeleted: 1 },
        outboxes: [{ id: "reports.outbox", completedDeleted: 2, deadLetteredDeleted: 0 }],
      },
    });
    expect(outboxCleanup).toHaveBeenCalledWith(
      { completedMs: 100, deadLetteredMs: 200 },
      new Date("2026-09-18T03:00:00.000Z"),
    );
    expect(lock.calls).toEqual(["acquire jobs.cleanup:cleanup", "release jobs.cleanup:cleanup"]);
  });

  it("validates its options", () => {
    const noRetention = defineOutbox({
      id: "plain.outbox",
      intents: {
        notify: outboxIntent({
          payload: z.object({ recipient: z.string() }),
          effect: notifier,
          perform: ({ effect, payload }) => effect.send(payload),
        }),
      },
    });
    for (const options of [
      null,
      { trigger: { kind: "enqueue" } },
      { trigger: { kind: "interval", everyMs: 10 }, id: "cleanup" },
      { trigger: { kind: "interval", everyMs: 10 }, outboxes: [{}] },
      { trigger: { kind: "interval", everyMs: 10 }, outboxes: [noRetention] },
      { trigger: { kind: "interval", everyMs: 10 }, clock: 1 },
    ]) {
      expect(() => defineJobCleanup(options as never)).toThrow(InvalidJobDefinitionError);
    }
    expect(
      defineJobCleanup({ id: "ops.sweep", trigger: { kind: "interval", everyMs: 10 } }).id,
    ).toBe("ops.sweep");
  });
});
