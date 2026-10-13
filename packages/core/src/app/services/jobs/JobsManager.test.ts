import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests focus on the producer side and `WORKER_MODE` resolution. Worker
 * dispatch + repeatable scheduling depend on a live Redis (BullMQ Worker
 * subscribes via BLPOP-style commands), and live there in the
 * testcontainers integration suite — out of scope for this unit batch.
 *
 * We mock `bullmq` so Queue / Worker construction doesn't dial Redis.
 */

interface QueueAddCall {
  jobName: string;
  payload: unknown;
  opts: unknown;
}

const queueAdds = new Map<string, QueueAddCall[]>(); // queueName → calls
const queueClosed = vi.fn();
const workerClosed = vi.fn();
let workerCount = 0;

vi.mock("bullmq", () => {
  class FakeQueue {
    public readonly name: string;
    constructor(name: string) {
      this.name = name;
      queueAdds.set(name, []);
    }
    async add(jobName: string, payload: unknown, opts?: unknown) {
      queueAdds.get(this.name)!.push({ jobName, payload, opts });
    }
    async close() {
      queueClosed();
    }
  }
  class FakeWorker {
    constructor() {
      workerCount += 1;
    }
    on() {
      /* event listener — no-op in tests */
    }
    async close() {
      workerClosed();
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker };
});

import { defineJob, JobRegistry } from "./defineJob.js";
import { JobsManager } from "./JobsManager.js";

describe("JobsManager — mode resolution", () => {
  const originalMode = process.env.WORKER_MODE;
  afterEach(() => {
    if (originalMode === undefined) delete process.env.WORKER_MODE;
    else process.env.WORKER_MODE = originalMode;
  });

  it("explicit mode wins over env", () => {
    process.env.WORKER_MODE = "worker";
    const m = new JobsManager({
      connection: { host: "localhost", port: 6379 },
      mode: "api",
    });
    expect(m.getMode()).toBe("api");
  });

  it("falls back to WORKER_MODE env when no explicit mode", () => {
    process.env.WORKER_MODE = "all";
    const m = new JobsManager({ connection: { host: "x", port: 1 } });
    expect(m.getMode()).toBe("all");
  });

  it("defaults to 'api' when nothing is set", () => {
    delete process.env.WORKER_MODE;
    const m = new JobsManager({ connection: { host: "x", port: 1 } });
    expect(m.getMode()).toBe("api");
  });

  it("ignores unknown WORKER_MODE values", () => {
    process.env.WORKER_MODE = "bogus";
    const m = new JobsManager({ connection: { host: "x", port: 1 } });
    expect(m.getMode()).toBe("api");
  });
});

describe("JobsManager.enqueue", () => {
  let registry: JobRegistry;

  beforeEach(() => {
    queueAdds.clear();
    workerCount = 0;
    registry = new JobRegistry();
    defineJob(
      {
        queue: "emails",
        name: "send-welcome",
        handler: async () => undefined,
        options: { defaultJobOptions: { attempts: 3 } },
      },
      registry,
    );
  });

  it("constructs a Queue lazily on first enqueue", async () => {
    const m = new JobsManager({
      connection: { host: "localhost", port: 6379 },
      registry,
      mode: "api",
    });
    expect(queueAdds.size).toBe(0);
    await m.enqueue("emails", "send-welcome", { to: "alice@example.com" });
    expect(queueAdds.has("emails")).toBe(true);
  });

  it("forwards the payload + name to Queue.add", async () => {
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
      mode: "api",
    });
    await m.enqueue("emails", "send-welcome", { to: "x" });
    const calls = queueAdds.get("emails")!;
    expect(calls).toHaveLength(1);
    expect(calls[0].jobName).toBe("send-welcome");
    expect(calls[0].payload).toEqual({ to: "x" });
  });

  it("merges per-call opts over the job's defaultJobOptions", async () => {
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
      mode: "api",
    });
    await m.enqueue("emails", "send-welcome", {}, { priority: 5 });
    const opts = queueAdds.get("emails")![0].opts as { attempts: number; priority: number };
    expect(opts.attempts).toBe(3);
    expect(opts.priority).toBe(5);
  });

  it("throws if the (queue, name) is not registered", async () => {
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
      mode: "api",
    });
    await expect(m.enqueue("emails", "missing", {})).rejects.toThrow(/no job "missing" registered/);
  });

  it("getQueue() returns the same Queue across calls (caches)", () => {
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
    });
    const a = m.getQueue("emails");
    const b = m.getQueue("emails");
    expect(a).toBe(b);
  });
});

describe("JobsManager.startWorkers", () => {
  let registry: JobRegistry;

  beforeEach(() => {
    workerCount = 0;
    queueClosed.mockClear();
    workerClosed.mockClear();
    registry = new JobRegistry();
    defineJob({ queue: "emails", name: "a", handler: async () => undefined }, registry);
    defineJob(
      { queue: "emails", name: "b", handler: async () => undefined, options: { concurrency: 4 } },
      registry,
    );
    defineJob({ queue: "billing", name: "c", handler: async () => undefined }, registry);
  });

  it("api mode starts no workers", async () => {
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
      mode: "api",
    });
    const count = await m.startWorkers();
    expect(count).toBe(0);
    expect(workerCount).toBe(0);
  });

  it("worker mode starts one worker per distinct queue", async () => {
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
      mode: "worker",
    });
    const count = await m.startWorkers();
    expect(count).toBe(2); // emails + billing
    expect(workerCount).toBe(2);
  });

  it("all mode starts workers (HTTP server is the App.ts caller's job)", async () => {
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
      mode: "all",
    });
    const count = await m.startWorkers();
    expect(count).toBe(2);
  });

  it("startWorkers is idempotent", async () => {
    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
      mode: "worker",
    });
    await m.startWorkers();
    const count = await m.startWorkers();
    expect(count).toBe(2);
    expect(workerCount).toBe(2); // not 4
  });
});

describe("JobsManager.quit", () => {
  it("closes all queues + workers; idempotent", async () => {
    queueClosed.mockClear();
    workerClosed.mockClear();
    workerCount = 0;

    const registry = new JobRegistry();
    defineJob({ queue: "q", name: "n", handler: async () => undefined }, registry);

    const m = new JobsManager({
      connection: { host: "x", port: 1 },
      registry,
      mode: "worker",
    });
    await m.startWorkers();
    await m.enqueue("q", "n", {});

    await m.quit();
    expect(workerClosed).toHaveBeenCalled();
    expect(queueClosed).toHaveBeenCalled();

    // idempotent
    await expect(m.quit()).resolves.toBeUndefined();
  });
});
