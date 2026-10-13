import { afterEach, describe, expect, it, vi } from "vitest";
import { JobRegistry, jobRegistry } from "../jobs/defineJob.js";
import { CRON_QUEUE, defineCron } from "./defineCron.js";

describe("defineCron", () => {
  afterEach(() => {
    jobRegistry.clear();
  });

  it("registers under the default 'cron' queue", () => {
    const reg = new JobRegistry();
    defineCron(
      {
        name: "purge-tokens",
        schedule: "0 2 * * *",
        handler: async () => undefined,
      },
      reg,
    );

    const job = reg.find(CRON_QUEUE, "purge-tokens");
    expect(job).toBeDefined();
    expect(job!.queue).toBe("cron");
  });

  it("threads the cron expression into JobDefinition.options.schedule.cron", () => {
    const reg = new JobRegistry();
    const def = defineCron(
      {
        name: "tick",
        schedule: "*/5 * * * *",
        handler: async () => undefined,
      },
      reg,
    );
    expect(def.options?.schedule).toEqual({ cron: "*/5 * * * *", tz: undefined });
  });

  it("supports a tz override", () => {
    const reg = new JobRegistry();
    const def = defineCron(
      {
        name: "morning",
        schedule: "0 8 * * *",
        tz: "America/New_York",
        handler: async () => undefined,
      },
      reg,
    );
    expect(def.options?.schedule).toEqual({
      cron: "0 8 * * *",
      tz: "America/New_York",
    });
  });

  it("supports a custom queue (e.g., 'cron.billing')", () => {
    const reg = new JobRegistry();
    const def = defineCron(
      {
        name: "invoice",
        schedule: "0 0 1 * *",
        queue: "cron.billing",
        handler: async () => undefined,
      },
      reg,
    );
    expect(def.queue).toBe("cron.billing");
    expect(reg.find("cron.billing", "invoice")).toBeDefined();
    expect(reg.find(CRON_QUEUE, "invoice")).toBeUndefined();
  });

  it("auto-registers into the framework jobRegistry by default", () => {
    defineCron({
      name: "hourly",
      schedule: "0 * * * *",
      handler: async () => undefined,
    });
    expect(jobRegistry.find(CRON_QUEUE, "hourly")).toBeDefined();
  });

  it("respects register: false", () => {
    defineCron(
      {
        name: "isolated",
        schedule: "* * * * *",
        handler: async () => undefined,
      },
      false,
    );
    expect(jobRegistry.size()).toBe(0);
  });

  it("the handler signature is `(void, ctx) => Promise<...>` — payload is void", async () => {
    const reg = new JobRegistry();
    const handler = vi.fn(async () => "result");
    const def = defineCron(
      {
        name: "test",
        schedule: "* * * * *",
        handler,
      },
      reg,
    );
    // Manually invoke (the real BullMQ Worker would pass undefined for void payloads)
    await def.handler(undefined, {
      // Minimal stub of the handler context — sufficient for shape verification.
      job: {} as never,
      context: {},
    });
    expect(handler).toHaveBeenCalledWith(undefined, expect.any(Object));
  });

  it("CRON_QUEUE constant is the default queue name", () => {
    expect(CRON_QUEUE).toBe("cron");
  });
});
