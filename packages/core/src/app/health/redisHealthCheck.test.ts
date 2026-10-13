import { describe, expect, it, vi } from "vitest";
import type { RedisProvider } from "../services/RedisProvider.js";
import { redisHealthCheck } from "./redisHealthCheck.js";

function fakeProvider(pingResult: boolean | (() => Promise<boolean>)): RedisProvider {
  const ping = typeof pingResult === "function" ? pingResult : async () => pingResult;
  return { ping } as unknown as RedisProvider;
}

describe("redisHealthCheck", () => {
  it("returns ok: true on a successful ping", async () => {
    const check = redisHealthCheck(fakeProvider(true));
    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  it("returns ok: false with `ping failed` error on a failed ping", async () => {
    const check = redisHealthCheck(fakeProvider(false));
    const result = await check.check();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ping failed");
  });

  it("uses 'redis' as the default name", () => {
    const check = redisHealthCheck(fakeProvider(true));
    expect(check.name).toBe("redis");
  });

  it("supports a custom name (for multi-Redis setups)", () => {
    const check = redisHealthCheck(fakeProvider(true), { name: "redis.cache" });
    expect(check.name).toBe("redis.cache");
  });

  it("invokes provider.ping() exactly once per check", async () => {
    const ping = vi.fn(async () => true);
    const provider = { ping } as unknown as RedisProvider;
    const check = redisHealthCheck(provider);
    await check.check();
    expect(ping).toHaveBeenCalledOnce();
  });
});
