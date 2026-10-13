import { describe, expect, it } from "vitest";
import {
  getRequestContext,
  type RequestContext,
  requestContextStore,
  runWithRequestContext,
  setRequestContextField,
} from "./RequestContext.js";

describe("RequestContext", () => {
  it("returns undefined when no context is active", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("propagates context inside runWithRequestContext", () => {
    runWithRequestContext({ requestId: "req-1", userId: "u-1" }, () => {
      const ctx = getRequestContext();
      expect(ctx).toEqual({ requestId: "req-1", userId: "u-1" });
    });
    expect(getRequestContext()).toBeUndefined();
  });

  it("preserves context across an async boundary", async () => {
    await runWithRequestContext({ requestId: "req-async" }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(getRequestContext()).toMatchObject({ requestId: "req-async" });
    });
  });

  it("nested runWithRequestContext shadows the outer context", () => {
    runWithRequestContext({ requestId: "outer" }, () => {
      runWithRequestContext({ requestId: "inner" }, () => {
        expect(getRequestContext()?.requestId).toBe("inner");
      });
      expect(getRequestContext()?.requestId).toBe("outer");
    });
  });

  it("setRequestContextField mutates the active context", () => {
    runWithRequestContext({ requestId: "req-2" }, () => {
      const ok = setRequestContextField("userId", "u-late");
      expect(ok).toBe(true);
      expect(getRequestContext()).toMatchObject({
        requestId: "req-2",
        userId: "u-late",
      });
    });
  });

  it("setRequestContextField returns false outside an active context", () => {
    expect(setRequestContextField("userId", "x")).toBe(false);
  });

  it("supports the optional `tx` field for transaction propagation", () => {
    const fakeTx = { id: "tx-1" };
    runWithRequestContext({ tx: fakeTx }, () => {
      expect((getRequestContext()?.tx as typeof fakeTx).id).toBe("tx-1");
    });
  });

  it("supports the optional `extra` field for free-form metadata", () => {
    const extra: RequestContext["extra"] = { traceId: "trace-1", route: "/me" };
    runWithRequestContext({ extra }, () => {
      expect(getRequestContext()?.extra).toEqual(extra);
    });
  });

  it("exposes the underlying AsyncLocalStorage for advanced consumers", () => {
    expect(requestContextStore).toBeDefined();
    expect(typeof requestContextStore.run).toBe("function");
  });
});
