import { describe, expect, it, vi } from "vitest";
import { type RedisEvalClient, RedisSlidingWindowBackend } from "./RedisSlidingWindowBackend.js";

/**
 * Lua-script semantics aren't exercised here (that needs real Redis or a
 * Lua-aware fake — covered later by testcontainers integration tests).
 * What we *can* verify is:
 *   - The wrapper namespaces keys with `keyPrefix`.
 *   - It passes through windowMs, max, now, and a unique entry ID.
 *   - It interprets the Lua script's `[allowed, used, limit, resetAtMs]`
 *     return tuple correctly.
 */

interface Capture {
  script: string;
  numKeys: number;
  args: (string | number)[];
}

function makeFakeClient(returnValue: [number, number, number, number]): {
  client: RedisEvalClient;
  calls: Capture[];
} {
  const calls: Capture[] = [];
  return {
    client: {
      eval: vi.fn(async (script: string, numKeys: number, ...args: (string | number)[]) => {
        calls.push({ script, numKeys, args: [...args] });
        return returnValue;
      }),
    },
    calls,
  };
}

describe("RedisSlidingWindowBackend", () => {
  it("namespaces the key with the default 'ratelimit:' prefix", async () => {
    const { client, calls } = makeFakeClient([1, 1, 5, 1_060_000]);
    const backend = new RedisSlidingWindowBackend({ client });

    await backend.check({ key: "user:42", windowMs: 60_000, max: 5, now: 1_000_000 });

    expect(calls).toHaveLength(1);
    expect(calls[0].numKeys).toBe(1);
    expect(calls[0].args[0]).toBe("ratelimit:user:42"); // namespaced key
  });

  it("uses a custom keyPrefix when supplied", async () => {
    const { client, calls } = makeFakeClient([1, 1, 5, 1_060_000]);
    const backend = new RedisSlidingWindowBackend({ client, keyPrefix: "rl:v4:" });

    await backend.check({ key: "ip:1.2.3.4", windowMs: 60_000, max: 5, now: 1_000_000 });

    expect(calls[0].args[0]).toBe("rl:v4:ip:1.2.3.4");
  });

  it("forwards now / windowMs / max as Lua args, plus a unique entry ID", async () => {
    const { client, calls } = makeFakeClient([1, 1, 5, 1_060_000]);
    const backend = new RedisSlidingWindowBackend({ client });

    await backend.check({ key: "k", windowMs: 60_000, max: 5, now: 1_000_000 });

    // [namespacedKey, now, windowMs, max, entryId]
    expect(calls[0].args[1]).toBe(1_000_000);
    expect(calls[0].args[2]).toBe(60_000);
    expect(calls[0].args[3]).toBe(5);
    expect(typeof calls[0].args[4]).toBe("string");
    expect(String(calls[0].args[4])).toContain("1000000");
  });

  it("uses unique entry IDs across consecutive calls (no Sorted-Set merge)", async () => {
    const { client, calls } = makeFakeClient([1, 1, 5, 1_060_000]);
    const backend = new RedisSlidingWindowBackend({ client });

    await backend.check({ key: "k", windowMs: 60_000, max: 5, now: 1_000_000 });
    await backend.check({ key: "k", windowMs: 60_000, max: 5, now: 1_000_000 });

    expect(calls[0].args[4]).not.toBe(calls[1].args[4]);
  });

  it("translates an ALLOWED Lua result correctly", async () => {
    const { client } = makeFakeClient([1, 3, 5, 1_060_000]);
    const backend = new RedisSlidingWindowBackend({ client });

    const r = await backend.check({ key: "k", windowMs: 60_000, max: 5, now: 1_000_000 });
    expect(r).toEqual({ allowed: true, used: 3, limit: 5, resetAtMs: 1_060_000 });
  });

  it("translates a DENIED Lua result correctly", async () => {
    const { client } = makeFakeClient([0, 5, 5, 1_059_500]);
    const backend = new RedisSlidingWindowBackend({ client });

    const r = await backend.check({ key: "k", windowMs: 60_000, max: 5, now: 1_000_000 });
    expect(r).toEqual({ allowed: false, used: 5, limit: 5, resetAtMs: 1_059_500 });
  });

  it("propagates errors from eval()", async () => {
    const failing: RedisEvalClient = {
      eval: async () => {
        throw new Error("redis down");
      },
    };
    const backend = new RedisSlidingWindowBackend({ client: failing });

    await expect(
      backend.check({ key: "k", windowMs: 60_000, max: 5, now: 1_000_000 }),
    ).rejects.toThrow("redis down");
  });
});
