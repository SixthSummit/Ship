import {
  createExecutor,
  defineApp,
  defineJob,
  defineModule,
  humanActor,
  type JobBackend,
  jobBackendDependency,
  permission,
  valueProvider,
} from "@sixthsummit/ship-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHonoAdapter } from "./adapter.js";
import {
  HttpJobTriggerError,
  httpJobResultTrigger,
  httpJobTrigger,
  jobQueueFull,
} from "./job-trigger.js";
import {
  bearerTokenCredentials,
  constantTimeEqual,
  jobTriggerActorResolver,
  jobTriggerPermission,
} from "./job-trigger-auth.js";
import { http } from "./transport.js";

const digest = defineJob({
  id: "reports.digest",
  input: z.object({ tenantId: z.string().min(1) }),
  trigger: { kind: "http", access: permission(jobTriggerPermission("reports.digest")) },
  concurrency: { mode: "parallel" },
  retry: { attempts: 2, backoff: { initialMs: 10 } },
  transaction: "none",
  dependencies: {},
  handler: async ({ input }) => ({ tenantId: input.tenantId }),
});

function fakeBackend(queueFull = false) {
  const enqueue = vi.fn(async (_jobId: string, _input: unknown, _options: unknown) =>
    queueFull
      ? ({ accepted: false, rejected: "queue-full" } as const)
      : ({ accepted: true, runId: "run-1", deduplicated: false } as const),
  );
  const backend: JobBackend = {
    kind: "ship.job-backend",
    adapter: "fake",
    concurrencyBudget: { maxInFlight: 1, maxQueueDepth: 1 },
    attach: () => undefined,
    enqueue,
    schedule: async () => undefined,
    unschedule: async () => undefined,
    startWorkers: async () => 0,
    quit: async () => undefined,
    health: async () => ({ jobs: [] }),
    listFailed: async () => [],
    retry: async () => undefined,
    discard: async () => undefined,
    cleanup: async () => ({ completedDeleted: 0, deadLetteredDeleted: 0 }),
  };
  return { backend, enqueue };
}

function application(backend: JobBackend, trigger = httpJobTrigger(digest)) {
  return defineApp({
    id: "jobs-http",
    modules: [
      defineModule({
        id: "reports",
        operations: [digest, trigger],
        providers: [valueProvider(jobBackendDependency(), backend)],
        imports: [],
        exports: [],
      }),
    ],
  });
}

describe("httpJobTrigger", () => {
  it("projects an http-triggered job onto POST /jobs/<id> with the trigger access", async () => {
    const trigger = httpJobTrigger(digest, { dedupeKey: (input) => input.tenantId, delayMs: 5 });
    expect(trigger.id).toBe("reports.digest.trigger");
    expect(trigger.transport).toMatchObject({ kind: "http", binding: "POST /jobs/reports.digest" });
    expect(trigger.access).toEqual(permission("ship.jobs:trigger:reports.digest"));
    expect(trigger.errors).toEqual([jobQueueFull]);

    const { backend, enqueue } = fakeBackend();
    const app = application(backend, trigger);
    expect(app.graph.jobs[0]?.operations.triggers).toEqual(["reports.digest.trigger"]);

    const result = await createExecutor(app).run(
      "reports.digest.trigger",
      { body: { tenantId: "acme" } },
      { actor: humanActor({ id: "scheduler", permissions: ["ship.jobs:trigger:reports.digest"] }) },
    );
    expect(result).toMatchObject({
      ok: true,
      status: 202,
      data: { accepted: true, runId: "run-1", deduplicated: false },
    });
    expect(enqueue).toHaveBeenCalledWith(
      "reports.digest",
      { tenantId: "acme" },
      { dedupeKey: "acme", delayMs: 5 },
    );
  });

  it("maps queue-full to the declared 429 failure", async () => {
    const { backend } = fakeBackend(true);
    await expect(
      createExecutor(application(backend)).run(
        "reports.digest.trigger",
        { body: { tenantId: "acme" } },
        { actor: humanActor({ id: "s", permissions: ["ship.jobs:trigger:reports.digest"] }) },
      ),
    ).resolves.toMatchObject({ ok: false, status: 429, error: { code: "JOB_QUEUE_FULL" } });
  });

  it("rejects non-jobs, non-http triggers and invalid options", () => {
    expect(() => httpJobTrigger({} as never)).toThrow(HttpJobTriggerError);
    const scheduled = defineJob({
      id: "reports.scheduled",
      input: z.object({}),
      trigger: { kind: "schedule", cron: "0 * * * *", tz: "UTC" },
      concurrency: { mode: "parallel" },
      retry: { attempts: 1, backoff: { initialMs: 1 } },
      transaction: "none",
      dependencies: {},
      handler: async () => undefined,
    });
    expect(() => httpJobTrigger(scheduled)).toThrow(
      expect.objectContaining({ code: "SHIP_HONO_JOB_TRIGGER_KIND_INVALID" }),
    );
    for (const options of [
      null,
      { path: "jobs" },
      { dedupeKey: "static" },
      { delayMs: -1 },
      { requestBody: http.body.raw({ maxBytes: 10 }) },
    ]) {
      expect(() => httpJobTrigger(digest, options as never)).toThrow(
        expect.objectContaining({ code: "SHIP_HONO_JOB_TRIGGER_OPTIONS_INVALID" }),
      );
    }
    expect(httpJobTrigger(digest, { path: "/scheduler/digest" }).transport.binding).toBe(
      "POST /scheduler/digest",
    );
  });

  it("authenticates schedulers through the app's actor resolver over HTTP", async () => {
    const { backend, enqueue } = fakeBackend();
    const verify = vi.fn(async (token: string) =>
      token === "aaa.bbb.ccc"
        ? { subject: "scheduler@example.iam", permissions: ["ship.jobs:trigger:reports.digest"] }
        : undefined,
    );
    const adapter = createHonoAdapter(application(backend), {
      auth: {
        credentials: bearerTokenCredentials(),
        actors: jobTriggerActorResolver({
          identityTokens: { verify },
          bearerSecrets: [
            {
              secret: "scoped-secret-with-length",
              actorId: "cron.legacy",
              permissions: ["ship.jobs:trigger:reports.digest"],
            },
          ],
        }),
      },
    });
    const post = (authorization?: string) =>
      adapter.request("/jobs/reports.digest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ tenantId: "acme" }),
      });

    expect((await post("Bearer aaa.bbb.ccc")).status).toBe(202);
    expect((await post("Bearer scoped-secret-with-length")).status).toBe(202);
    expect((await post("Bearer zzz.yyy.xxx")).status).toBe(401);
    expect((await post("Bearer wrong-secret-with-length")).status).toBe(401);
    expect((await post("Basic abc")).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledWith("aaa.bbb.ccc");
  });
});

describe("httpJobResultTrigger", () => {
  const actor = humanActor({ id: "scheduler", permissions: ["ship.jobs:trigger:reports.digest"] });
  const run = (backend: JobBackend) =>
    createExecutor(application(backend, httpJobResultTrigger(digest, { timeoutMs: 25 }))).run(
      "reports.digest.trigger",
      { body: { tenantId: "acme" } },
      { actor },
    );

  it("returns the durable result as the POST/200 body", async () => {
    const { backend } = fakeBackend();
    backend.waitForResult = vi.fn(async () => ({
      status: "completed" as const,
      runId: "run-1",
      data: { tenantId: "acme" },
    }));
    await expect(run(backend)).resolves.toMatchObject({
      ok: true,
      status: 200,
      data: { tenantId: "acme" },
    });
    expect(backend.waitForResult).toHaveBeenCalledWith("run-1", { timeoutMs: 25 });
  });

  it("uses a delivery key to read back the same retained terminal run on a retry", async () => {
    const { backend, enqueue } = fakeBackend();
    backend.waitForResult = vi.fn(async () => ({
      status: "completed" as const,
      runId: "run-1",
      data: { tenantId: "acme" },
    }));
    const trigger = httpJobResultTrigger(digest, {
      timeoutMs: 25,
      dedupeKey: (input) => `scheduler:${input.tenantId}`,
    });
    const result = await createExecutor(application(backend, trigger)).run(
      "reports.digest.trigger",
      { body: { tenantId: "acme" } },
      { actor },
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(enqueue).toHaveBeenCalledWith(
      "reports.digest",
      { tenantId: "acme" },
      {
        dedupeKey: "scheduler:acme",
        reuseTerminalDedupe: true,
      },
    );
  });

  it("projects the result through an authenticated HTTP POST", async () => {
    const { backend } = fakeBackend();
    backend.waitForResult = vi.fn(async () => ({
      status: "completed" as const,
      runId: "run-1",
      data: { tenantId: "acme" },
    }));
    const adapter = createHonoAdapter(
      application(backend, httpJobResultTrigger(digest, { timeoutMs: 25 })),
      {
        auth: {
          credentials: bearerTokenCredentials(),
          actors: jobTriggerActorResolver({
            bearerSecrets: [
              {
                secret: "scoped-secret-with-length",
                actorId: "cron.legacy",
                permissions: ["ship.jobs:trigger:reports.digest"],
              },
            ],
          }),
        },
      },
    );
    const response = await adapter.request("/jobs/reports.digest", {
      method: "POST",
      headers: {
        authorization: "Bearer scoped-secret-with-length",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: "acme" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: "acme" });
  });

  it.each([
    "pending",
    "missing",
    "failed",
  ] as const)("returns the durable run id for %s without enqueueing another job", async (status) => {
    const { backend, enqueue } = fakeBackend();
    backend.waitForResult = vi.fn(async () =>
      status === "failed"
        ? { status, runId: "run-1", error: "failure" }
        : { status, runId: "run-1" },
    );
    await expect(run(backend)).resolves.toMatchObject({
      ok: false,
      status: status === "pending" ? 504 : status === "failed" ? 502 : 503,
      error: { details: { runId: "run-1" } },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsupported backend before creating a run", async () => {
    const { backend, enqueue } = fakeBackend();
    await expect(run(backend)).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: { code: "JOB_RESULT_UNAVAILABLE" },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("preserves the run id when backend observation fails after enqueue", async () => {
    const { backend, enqueue } = fakeBackend();
    backend.waitForResult = vi.fn(async () => {
      throw new Error("redis unavailable");
    });
    await expect(run(backend)).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: { code: "JOB_RESULT_READ_FAILED", details: { runId: "run-1" } },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("preserves the run id when a completed job returned no JSON result", async () => {
    const { backend } = fakeBackend();
    backend.waitForResult = vi.fn(async () => ({
      status: "completed" as const,
      runId: "run-1",
      data: undefined,
    }));
    await expect(run(backend)).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: { code: "JOB_RESULT_INVALID", details: { runId: "run-1" } },
    });
  });

  it("validates the bounded wait options", () => {
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: 120_001 },
      { timeoutMs: 100, dedupeKey: "x" },
    ]) {
      expect(() => httpJobResultTrigger(digest, options as never)).toThrow(HttpJobTriggerError);
    }
  });
});

describe("jobTriggerActorResolver", () => {
  const request = (credential: unknown) => ({
    credential: credential as never,
    operation: { id: "reports.digest.trigger", access: permission("x:y") },
    requestId: "r",
  });

  it("produces permissionless-by-default system actors and verified identities", async () => {
    const resolver = jobTriggerActorResolver({
      identityProvider: "google.oidc",
      identityTokens: { verify: async () => ({ subject: "svc", actorId: "scheduler.svc" }) },
    });
    const resolution = await resolver.resolve(request({ kind: "bearer", token: "a.b.c" }));
    expect(resolution).toMatchObject({
      ok: true,
      identity: { provider: "google.oidc", subject: "svc" },
      actor: { id: "scheduler.svc", kind: "system" },
    });
    if (resolution.ok) expect(resolution.actor?.permissions?.size).toBe(0);
    expect(await resolver.resolve(request({ kind: "malformed" }))).toEqual({
      ok: false,
      reason: "invalid-credential",
    });
    expect(await resolver.resolve(request(undefined))).toEqual({ ok: true });
    // A non-JWT bearer with no secrets configured is rejected.
    expect(await resolver.resolve(request({ kind: "bearer", token: "plain" }))).toEqual({
      ok: false,
      reason: "invalid-credential",
    });
  });

  it("reports verifier failures as unavailable and defers to a fallback resolver", async () => {
    const fallback = {
      id: "auth.session",
      resolve: vi.fn(async () => ({ ok: true as const, actor: humanActor({ id: "person" }) })),
    };
    const resolver = jobTriggerActorResolver({
      identityTokens: {
        verify: async () => {
          throw new Error("jwks down");
        },
      },
      fallback,
    });
    expect(await resolver.resolve(request({ kind: "bearer", token: "a.b.c" }))).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await resolver.resolve(request(undefined))).toMatchObject({
      ok: true,
      actor: { id: "person" },
    });
    expect(
      await resolver.resolve(request({ kind: "bearer", token: "session-token" })),
    ).toMatchObject({
      ok: true,
      actor: { id: "person" },
    });
    expect(fallback.resolve).toHaveBeenCalledTimes(2);
  });

  it("validates options", () => {
    expect(() => jobTriggerActorResolver({})).toThrow(TypeError);
    expect(() => jobTriggerActorResolver(null as never)).toThrow(TypeError);
    expect(() => jobTriggerActorResolver({ identityTokens: {} as never })).toThrow(TypeError);
    expect(() =>
      jobTriggerActorResolver({
        bearerSecrets: [{ secret: "short", actorId: "a", permissions: [] }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      jobTriggerActorResolver({
        bearerSecrets: [{ secret: "long-enough-secret!", actorId: "a", permissions: [] }],
        identityProvider: "Bad Provider",
      }),
    ).toThrow(TypeError);
  });

  it("extracts bearer tokens and compares secrets in constant time", async () => {
    const adapter = bearerTokenCredentials();
    expect(
      await adapter.extract(new Request("https://x", { headers: { authorization: "Bearer t" } })),
    ).toEqual({
      kind: "bearer",
      token: "t",
    });
    expect(
      await adapter.extract(new Request("https://x", { headers: { authorization: "Bearer" } })),
    ).toEqual({
      kind: "malformed",
    });
    expect(await adapter.extract(new Request("https://x"))).toBeUndefined();
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(jobTriggerPermission("reports.digest")).toBe("ship.jobs:trigger:reports.digest");
  });
});
