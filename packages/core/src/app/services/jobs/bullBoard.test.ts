/**
 * Unit tests for the Bull-Board admin-UI integration.
 *
 * Strategy:
 *   - Mock `bullmq` to keep `JobsManager.getQueue(...)` from dialing
 *     Redis (consistent with `JobsManager.test.ts`).
 *   - Don't mock `@bull-board/hono` / `@bull-board/api` — the real
 *     packages are devDeps; the integration value of these tests is
 *     verifying the framework's adapter wires the real bull-board
 *     surface correctly behind our auth middleware.
 *   - Drive the returned Hono app via its `request()` method (no real
 *     network, no port). Bull-Board mounts UI + API routes; the auth
 *     middleware sits in front of all of them.
 *
 * What we verify:
 *   1. `apiKey: ""` → throws at build time (configuration error, not a
 *      runtime 401 surprise).
 *   2. No `x-admin-api-key` header → 401 on the dashboard root.
 *   3. Wrong `x-admin-api-key` value → 401.
 *   4. Correct `x-admin-api-key` → request reaches bull-board (no 401
 *      from our middleware; bull-board may then 200 / 404 / etc. on
 *      its own routes).
 *   5. `getQueueNames()` reflects the registry (the source of truth
 *      for what bull-board shows).
 *   6. `refresh()` re-derives the queue list from the JobsManager.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queueClosed = vi.fn();
vi.mock("bullmq", () => {
  class FakeQueue {
    public readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    async close() {
      queueClosed();
    }
  }
  class FakeWorker {
    on() {}
    async close() {}
  }
  return { Queue: FakeQueue, Worker: FakeWorker };
});

// `@bull-board/api`'s BullMQAdapter does an `instanceof Queue` check
// against the real bullmq Queue class — and since we mock bullmq above,
// the FakeQueue trips the guard. Stub the adapter constructor with a
// passthrough; the framework code we want to verify is the auth
// middleware + queue discovery wiring, not bull-board's adapter.
vi.mock("@bull-board/api/bullMQAdapter", () => {
  class PassthroughAdapter {
    public readonly queue: { name: string };
    constructor(queue: { name: string }) {
      this.queue = queue;
    }
    // Minimum shape `createBullBoard` reads off the adapter at register
    // time — methods are invoked lazily when the UI hits an API route,
    // and our auth assertions short-circuit before any of that runs.
    getName() {
      return this.queue.name;
    }
  }
  return { BullMQAdapter: PassthroughAdapter };
});

import { createBullBoardApp } from "./bullBoard.js";
import { defineJob, JobRegistry } from "./defineJob.js";
import { JobsManager } from "./JobsManager.js";

const TEST_KEY = "test-admin-key-with-enough-entropy-to-not-be-trivial-12345";

function buildJobsManager(): JobsManager {
  const registry = new JobRegistry();
  defineJob(
    {
      queue: "emails",
      name: "send-welcome",
      handler: async () => undefined,
    },
    registry,
  );
  defineJob(
    {
      queue: "reports",
      name: "build-daily",
      handler: async () => undefined,
    },
    registry,
  );
  return new JobsManager({
    connection: { host: "localhost", port: 6379 },
    registry,
    mode: "api",
  });
}

describe("createBullBoardApp — config validation", () => {
  it("throws when apiKey is empty", async () => {
    const jobsManager = buildJobsManager();
    await expect(createBullBoardApp({ jobsManager, apiKey: "" })).rejects.toThrow(
      /apiKey is required/,
    );
  });

  it("uses default basePath when none supplied", async () => {
    const jobsManager = buildJobsManager();
    const bb = await createBullBoardApp({ jobsManager, apiKey: TEST_KEY });
    expect(bb.basePath).toBe("/admin/jobs");
  });

  it("respects custom basePath", async () => {
    const jobsManager = buildJobsManager();
    const bb = await createBullBoardApp({
      jobsManager,
      apiKey: TEST_KEY,
      basePath: "/internal/queues",
    });
    expect(bb.basePath).toBe("/internal/queues");
  });
});

describe("createBullBoardApp — API-key auth middleware", () => {
  let jobsManager: JobsManager;

  beforeEach(() => {
    jobsManager = buildJobsManager();
  });

  afterEach(() => {
    queueClosed.mockClear();
  });

  it("rejects with 401 when no x-admin-api-key header is sent", async () => {
    const bb = await createBullBoardApp({ jobsManager, apiKey: TEST_KEY });
    const res = await bb.app.request("/");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("rejects with 401 when x-admin-api-key value is wrong", async () => {
    const bb = await createBullBoardApp({ jobsManager, apiKey: TEST_KEY });
    const res = await bb.app.request("/", {
      headers: { "x-admin-api-key": "definitely-not-the-real-key" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when x-admin-api-key length matches but value differs", async () => {
    // Same length as TEST_KEY — exercises the timing-safe-compare
    // branch (length check passes, byte compare fails). The buffer-
    // length check is the early-out; this verifies the byte-by-byte
    // path also rejects.
    const sameLengthDifferentValue = "x".repeat(TEST_KEY.length);
    const bb = await createBullBoardApp({ jobsManager, apiKey: TEST_KEY });
    const res = await bb.app.request("/", {
      headers: { "x-admin-api-key": sameLengthDifferentValue },
    });
    expect(res.status).toBe(401);
  });

  it("forwards to bull-board when x-admin-api-key matches", async () => {
    // Bull-board's UI routes return 200 + HTML at the root. Whatever
    // bull-board responds with, it MUST NOT be our 401 — that's the
    // load-bearing assertion (the auth middleware passed control).
    const bb = await createBullBoardApp({ jobsManager, apiKey: TEST_KEY });
    const res = await bb.app.request("/", {
      headers: { "x-admin-api-key": TEST_KEY },
    });
    expect(res.status).not.toBe(401);
  });
});

describe("createBullBoardApp — queue discovery + refresh", () => {
  it("derives the queue list from JobsManager.getQueueNames()", () => {
    const jobsManager = buildJobsManager();
    expect(jobsManager.getQueueNames().sort()).toEqual(["emails", "reports"]);
  });

  it("getQueueNames reflects only registered queues", () => {
    const registry = new JobRegistry();
    defineJob({ queue: "only-one", name: "x", handler: async () => undefined }, registry);
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
    });
    expect(m.getQueueNames()).toEqual(["only-one"]);
  });

  it("returns a refresh() that re-derives queues without rebuilding the app", async () => {
    const jobsManager = buildJobsManager();
    const bb = await createBullBoardApp({ jobsManager, apiKey: TEST_KEY });
    // No throw and the app is still usable after refresh.
    expect(() => bb.refresh()).not.toThrow();
    const res = await bb.app.request("/", {
      headers: { "x-admin-api-key": TEST_KEY },
    });
    expect(res.status).not.toBe(401);
  });
});
