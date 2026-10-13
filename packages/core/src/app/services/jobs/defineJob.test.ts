import { afterEach, describe, expect, it } from "vitest";
import { defineJob, type JobDefinition, JobRegistry, jobRegistry } from "./defineJob.js";

describe("defineJob — registration", () => {
  afterEach(() => {
    jobRegistry.clear();
  });

  it("registers into the framework jobRegistry by default", () => {
    defineJob({
      queue: "emails",
      name: "send-welcome",
      handler: async () => undefined,
    });
    expect(jobRegistry.size()).toBe(1);
    expect(jobRegistry.find("emails", "send-welcome")).toBeDefined();
  });

  it("returns the definition unchanged (so callers can store / reference it)", () => {
    const def = defineJob({
      queue: "emails",
      name: "ping",
      handler: async () => "pong",
      options: { concurrency: 5 },
    });
    expect(def.queue).toBe("emails");
    expect(def.options?.concurrency).toBe(5);
  });

  it("supports a custom registry (for tests / standalone modules)", () => {
    const reg = new JobRegistry();
    defineJob(
      {
        queue: "scoped",
        name: "x",
        handler: async () => undefined,
      },
      reg,
    );
    expect(reg.size()).toBe(1);
    expect(jobRegistry.size()).toBe(0);
  });

  it("supports register: false (no auto-registration)", () => {
    defineJob(
      {
        queue: "noop",
        name: "x",
        handler: async () => undefined,
      },
      false,
    );
    expect(jobRegistry.size()).toBe(0);
  });
});

describe("JobRegistry — operations", () => {
  let reg: JobRegistry;

  function defaultDef(overrides: Partial<JobDefinition> = {}): JobDefinition {
    return {
      queue: "q",
      name: "n",
      handler: async () => undefined,
      ...overrides,
    };
  }

  it("rejects duplicate (queue, name) tuples", () => {
    reg = new JobRegistry();
    reg.add(defaultDef({ queue: "emails", name: "send" }));
    expect(() => reg.add(defaultDef({ queue: "emails", name: "send" }))).toThrow(/duplicate/i);
  });

  it("allows the same name across different queues", () => {
    reg = new JobRegistry();
    reg.add(defaultDef({ queue: "a", name: "task" }));
    reg.add(defaultDef({ queue: "b", name: "task" }));
    expect(reg.size()).toBe(2);
  });

  it("byQueue returns only that queue's jobs", () => {
    reg = new JobRegistry();
    reg.add(defaultDef({ queue: "emails", name: "welcome" }));
    reg.add(defaultDef({ queue: "emails", name: "reset" }));
    reg.add(defaultDef({ queue: "billing", name: "invoice" }));

    expect(reg.byQueue("emails")).toHaveLength(2);
    expect(reg.byQueue("billing")).toHaveLength(1);
    expect(reg.byQueue("missing")).toEqual([]);
  });

  it("queues() returns distinct queue names", () => {
    reg = new JobRegistry();
    reg.add(defaultDef({ queue: "emails", name: "a" }));
    reg.add(defaultDef({ queue: "emails", name: "b" }));
    reg.add(defaultDef({ queue: "billing", name: "c" }));
    expect(reg.queues().sort()).toEqual(["billing", "emails"]);
  });

  it("find returns the matching definition or undefined", () => {
    reg = new JobRegistry();
    const def = defaultDef({ queue: "x", name: "y" });
    reg.add(def);
    expect(reg.find("x", "y")).toBe(def);
    expect(reg.find("x", "missing")).toBeUndefined();
  });

  it("list returns a defensive copy", () => {
    reg = new JobRegistry();
    reg.add(defaultDef());
    const list = reg.list();
    (list as JobDefinition[]).push(defaultDef({ queue: "extra", name: "n" }));
    expect(reg.size()).toBe(1);
  });

  it("clear() empties the registry", () => {
    reg = new JobRegistry();
    reg.add(defaultDef());
    reg.clear();
    expect(reg.size()).toBe(0);
  });
});
