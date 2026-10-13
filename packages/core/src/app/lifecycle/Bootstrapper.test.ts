import { describe, expect, it } from "vitest";
import {
  type Bootstrapper,
  type BootstrapperContext,
  BootstrapperOrderingError,
  runBootstrappers,
  sortBootstrappers,
  validateBootstrappers,
} from "./Bootstrapper.js";

function bs(
  name: string,
  priority: number,
  init?: (ctx: BootstrapperContext) => Promise<void> | void,
  dependsOn?: readonly string[],
): Bootstrapper {
  return { name, priority, dependsOn, init: init ?? (() => undefined) };
}

describe("validateBootstrappers", () => {
  it("accepts an empty list", () => {
    expect(() => validateBootstrappers([])).not.toThrow();
  });

  it("accepts a well-formed dependency graph", () => {
    expect(() =>
      validateBootstrappers([
        bs("A", 10),
        bs("B", 20, undefined, ["A"]),
        bs("C", 30, undefined, ["A", "B"]),
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate names", () => {
    expect(() => validateBootstrappers([bs("A", 10), bs("A", 20)])).toThrow(
      BootstrapperOrderingError,
    );
    expect(() => validateBootstrappers([bs("A", 10), bs("A", 20)])).toThrow(/Duplicate/);
  });

  it("rejects unknown dependency names", () => {
    expect(() => validateBootstrappers([bs("A", 20, undefined, ["B"])])).toThrow(/not registered/);
  });

  it("rejects same-priority dependencies (ambiguous ordering)", () => {
    expect(() => validateBootstrappers([bs("A", 10), bs("B", 10, undefined, ["A"])])).toThrow(
      /strictly earlier/,
    );
  });

  it("rejects forward dependencies (dependent has lower priority than dependency)", () => {
    expect(() => validateBootstrappers([bs("A", 30), bs("B", 10, undefined, ["A"])])).toThrow(
      /strictly earlier/,
    );
  });
});

describe("sortBootstrappers", () => {
  it("orders by priority ascending", () => {
    const sorted = sortBootstrappers([bs("C", 30), bs("A", 10), bs("B", 20)]);
    expect(sorted.map((b) => b.name)).toEqual(["A", "B", "C"]);
  });

  it("preserves registration order on ties (stable)", () => {
    const sorted = sortBootstrappers([bs("first", 50), bs("second", 50), bs("third", 50)]);
    expect(sorted.map((b) => b.name)).toEqual(["first", "second", "third"]);
  });

  it("handles negative priorities", () => {
    const sorted = sortBootstrappers([bs("late", 100), bs("early", -10), bs("zero", 0)]);
    expect(sorted.map((b) => b.name)).toEqual(["early", "zero", "late"]);
  });

  it("returns a new array (does not mutate the input)", () => {
    const input = [bs("B", 20), bs("A", 10)];
    const sorted = sortBootstrappers(input);
    expect(sorted).not.toBe(input);
    expect(input.map((b) => b.name)).toEqual(["B", "A"]); // unchanged
  });
});

describe("runBootstrappers", () => {
  it("runs each init() in priority order, threading the context", async () => {
    const calls: string[] = [];
    const ctx = await runBootstrappers([
      bs("C", 30, (c) => {
        calls.push(`C-saw-${c.from}`);
        c.from = "C";
      }),
      bs("A", 10, (c) => {
        calls.push("A");
        c.from = "A";
      }),
      bs("B", 20, (c) => {
        calls.push(`B-saw-${c.from}`);
        c.from = "B";
      }),
    ]);
    expect(calls).toEqual(["A", "B-saw-A", "C-saw-B"]);
    expect(ctx.from).toBe("C");
  });

  it("supports async init()", async () => {
    const order: string[] = [];
    await runBootstrappers([
      bs("A", 10, async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("A");
      }),
      bs("B", 20, async () => {
        order.push("B");
      }),
    ]);
    expect(order).toEqual(["A", "B"]);
  });

  it("propagates errors from init() and stops the chain", async () => {
    const order: string[] = [];
    await expect(
      runBootstrappers([
        bs("A", 10, () => {
          order.push("A");
        }),
        bs("B", 20, () => {
          order.push("B");
          throw new Error("B failed");
        }),
        bs("C", 30, () => {
          order.push("C");
        }),
      ]),
    ).rejects.toThrow("B failed");
    expect(order).toEqual(["A", "B"]); // C never ran
  });

  it("validates by default (rejects bad graphs before any init runs)", async () => {
    let ranA = false;
    await expect(
      runBootstrappers([
        bs("A", 30, () => {
          ranA = true;
        }),
        bs("B", 10, undefined, ["A"]), // forward dep
      ]),
    ).rejects.toThrow(BootstrapperOrderingError);
    expect(ranA).toBe(false); // validation aborted before A ran
  });

  it("supports skipValidation: true (caller has pre-validated)", async () => {
    // Forward-dep would normally throw; with skipValidation we just run in
    // priority order. Useful for hot-reload scenarios with cached graphs.
    const order: string[] = [];
    await runBootstrappers(
      [
        bs("B", 10, () => {
          order.push("B");
        }),
        bs("A", 30, () => {
          order.push("A");
        }),
      ],
      { skipValidation: true },
    );
    expect(order).toEqual(["B", "A"]);
  });

  it("uses the supplied initial context when provided", async () => {
    const ctx = await runBootstrappers(
      [
        bs("A", 10, (c) => {
          c.added = "v";
        }),
      ],
      {
        context: { preset: "p" },
      },
    );
    expect(ctx).toEqual({ preset: "p", added: "v" });
  });

  it("returns an empty context when no bootstrappers are registered", async () => {
    const ctx = await runBootstrappers([]);
    expect(ctx).toEqual({});
  });
});

describe("dependsOn semantics — stable real-world example", () => {
  it("orders the documented v4 priorities correctly", async () => {
    const ranOrder: string[] = [];
    await runBootstrappers([
      bs(
        "InitOpenApi",
        70,
        () => {
          ranOrder.push("openapi");
        },
        ["InitModules"],
      ),
      bs("InitObservability", 0, () => {
        ranOrder.push("obs");
      }),
      bs("InitFirebaseApp", 10, () => {
        ranOrder.push("firebase");
      }),
      bs("InitDatabase", 20, () => {
        ranOrder.push("db");
      }),
      bs("InitRedis", 30, () => {
        ranOrder.push("redis");
      }),
      bs("InitMetricsServer", 40, () => {
        ranOrder.push("metrics");
      }),
      bs(
        "InitModules",
        50,
        () => {
          ranOrder.push("modules");
        },
        ["InitDatabase", "InitRedis"],
      ),
      bs(
        "InitJobs",
        60,
        () => {
          ranOrder.push("jobs");
        },
        ["InitRedis", "InitModules"],
      ),
      bs(
        "InitCron",
        65,
        () => {
          ranOrder.push("cron");
        },
        ["InitJobs"],
      ),
      bs("InitHealthRoutes", 80, () => {
        ranOrder.push("health");
      }),
      bs("InitDevRoutes", 85, () => {
        ranOrder.push("dev-routes");
      }),
    ]);

    expect(ranOrder).toEqual([
      "obs",
      "firebase",
      "db",
      "redis",
      "metrics",
      "modules",
      "jobs",
      "cron",
      "openapi",
      "health",
      "dev-routes",
    ]);
  });
});
