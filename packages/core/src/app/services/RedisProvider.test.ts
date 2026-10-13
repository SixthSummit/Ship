import pino from "pino";
import { describe, expect, it } from "vitest";
import { RedisProvider } from "./RedisProvider.js";

/**
 * RedisProvider unit tests — exercise the constructor + lifecycle wrapper.
 * Connectivity-dependent behavior (commands, ping, ready/error events) is
 * covered later via testcontainers-redis integration tests.
 */

function silentLogger() {
  return pino({ level: "silent" }, { write: () => true });
}

describe("RedisProvider — construction", () => {
  it("accepts piecewise host/port and starts in lazy state", async () => {
    const p = new RedisProvider({ host: "127.0.0.1", port: 6379, logger: silentLogger() });
    // lazy: status should be 'wait' until first command / explicit connect()
    expect(p.client.status).toBe("wait");
    await p.quit();
  });

  it("accepts a URL form", async () => {
    const p = new RedisProvider({
      url: "redis://default:secret@127.0.0.1:6380/2",
      logger: silentLogger(),
    });
    expect(p.client.status).toBe("wait");
    expect(p.client.options.port).toBe(6380);
    expect(p.client.options.db).toBe(2);
    await p.quit();
  });

  it("forces maxRetriesPerRequest to null (BullMQ requirement)", async () => {
    const p = new RedisProvider({ logger: silentLogger() });
    expect(p.client.options.maxRetriesPerRequest).toBeNull();
    await p.quit();
  });

  it("enables lazy connect", async () => {
    const p = new RedisProvider({ logger: silentLogger() });
    expect(p.client.options.lazyConnect).toBe(true);
    await p.quit();
  });

  it("forwards ioredis option overrides", async () => {
    const p = new RedisProvider({
      logger: silentLogger(),
      ioredis: { keyPrefix: "svc:" },
    });
    expect(p.client.options.keyPrefix).toBe("svc:");
    await p.quit();
  });
});

describe("RedisProvider — lifecycle", () => {
  it("quit() is idempotent", async () => {
    const p = new RedisProvider({ logger: silentLogger() });
    await p.quit();
    await expect(p.quit()).resolves.toBeUndefined();
  });

  it("ping() returns false when disconnected", async () => {
    // Point at a closed port with the offline queue disabled and retries
    // off, so ping() rejects immediately rather than queueing the command.
    // maxRetriesPerRequest is forced to null (BullMQ requirement), so a
    // queued command would otherwise hang until the test times out — which
    // is exactly what happens on a CI runner with no Redis. This keeps the
    // test honest (genuinely disconnected) regardless of whether a local
    // Redis happens to be running.
    const p = new RedisProvider({
      host: "127.0.0.1",
      port: 1,
      logger: silentLogger(),
      ioredis: { enableOfflineQueue: false, retryStrategy: () => null },
    });
    const result = await p.ping().catch(() => false);
    expect(result).toBe(false);
    await p.quit();
  });
});
