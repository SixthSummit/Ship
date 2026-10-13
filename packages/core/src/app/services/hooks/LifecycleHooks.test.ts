import { describe, expect, it, vi } from "vitest";
import { composeHooks } from "./LifecycleHooks.js";

interface Row {
  id: string;
  name: string;
  createdBy?: string;
}
type Insert = { name: string; createdBy?: string };
type Patch = Partial<Insert>;

describe("composeHooks", () => {
  it("chains beforeCreate hooks and threads transformed values through", async () => {
    const hooks = composeHooks<Row, Insert, Patch>(
      { beforeCreate: (v) => ({ ...v, name: v.name.toUpperCase() }) },
      { beforeCreate: (v, ctx) => ({ ...v, createdBy: ctx.userId }) },
    );

    const result = await hooks.beforeCreate!({ name: "alice" }, { userId: "u1" });
    expect(result).toEqual({ name: "ALICE", createdBy: "u1" });
  });

  it("treats undefined return as 'no change'", async () => {
    const hooks = composeHooks<Row, Insert, Patch>(
      { beforeCreate: () => undefined },
      { beforeCreate: (v) => ({ ...v, name: v.name + "!" }) },
    );

    const result = await hooks.beforeCreate!({ name: "alice" }, {});
    expect(result).toEqual({ name: "alice!" });
  });

  it("fires afterCreate hooks in LIFO order", async () => {
    const calls: string[] = [];
    const hooks = composeHooks<Row, Insert, Patch>(
      {
        afterCreate: () => {
          calls.push("first");
        },
      },
      {
        afterCreate: () => {
          calls.push("second");
        },
      },
      {
        afterCreate: () => {
          calls.push("third");
        },
      },
    );

    await hooks.afterCreate!({ id: "x", name: "alice" }, {});
    expect(calls).toEqual(["third", "second", "first"]);
  });

  it("threads beforeUpdate transformations and provides prev for diffing", async () => {
    const sawPrev = vi.fn();
    const hooks = composeHooks<Row, Insert, Patch>({
      beforeUpdate: (prev, patch) => {
        sawPrev(prev);
        return { ...patch, name: patch.name?.trim() };
      },
    });

    const out = await hooks.beforeUpdate!({ id: "x", name: "old" }, { name: "  new  " }, {});
    expect(out).toEqual({ name: "new" });
    expect(sawPrev).toHaveBeenCalledWith({ id: "x", name: "old" });
  });

  it("propagates throw from beforeDelete to abort the operation", async () => {
    const hooks = composeHooks<Row, Insert, Patch>({
      beforeDelete: () => {
        throw new Error("blocked by policy");
      },
    });

    await expect(hooks.beforeDelete!({ id: "x", name: "n" }, {})).rejects.toThrow(
      "blocked by policy",
    );
  });

  it("composes beforeQuery filters for multi-tenant scoping", async () => {
    const hooks = composeHooks<Row, Insert, Patch>(
      { beforeQuery: (f, ctx) => ({ ...f, tenantId: ctx.tenantId }) },
      { beforeQuery: (f) => ({ ...f, deletedAt: { isNull: true } }) },
    );

    const out = await hooks.beforeQuery!({ name: { eq: "alice" } }, { tenantId: "tenant-1" });
    expect(out).toEqual({
      name: { eq: "alice" },
      tenantId: "tenant-1",
      deletedAt: { isNull: true },
    });
  });

  it("handles empty hook sets gracefully", async () => {
    const hooks = composeHooks<Row, Insert, Patch>();
    expect(await hooks.beforeCreate!({ name: "a" }, {})).toEqual({ name: "a" });
    await expect(hooks.afterCreate!({ id: "x", name: "a" }, {})).resolves.toBeUndefined();
  });
});
