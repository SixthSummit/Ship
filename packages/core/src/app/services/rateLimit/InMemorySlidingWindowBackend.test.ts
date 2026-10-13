import { describe, expect, it } from "vitest";
import { InMemorySlidingWindowBackend } from "./InMemorySlidingWindowBackend.js";

describe("InMemorySlidingWindowBackend", () => {
  it("allows requests up to the ceiling", async () => {
    const backend = new InMemorySlidingWindowBackend();
    let now = 1_000_000;

    for (let i = 0; i < 5; i++) {
      const r = await backend.check({ key: "k", windowMs: 60_000, max: 5, now: now++ });
      expect(r.allowed).toBe(true);
      expect(r.used).toBe(i + 1);
      expect(r.limit).toBe(5);
    }
  });

  it("denies once the ceiling is reached", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const now = 1_000_000;

    for (let i = 0; i < 3; i++) {
      await backend.check({ key: "k", windowMs: 60_000, max: 3, now: now + i });
    }
    const denied = await backend.check({ key: "k", windowMs: 60_000, max: 3, now: now + 3 });
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(3);
  });

  it("isolates keys", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const now = 1_000_000;

    for (let i = 0; i < 3; i++) {
      await backend.check({ key: "a", windowMs: 60_000, max: 3, now: now + i });
    }
    const otherKey = await backend.check({ key: "b", windowMs: 60_000, max: 3, now });
    expect(otherKey.allowed).toBe(true);
  });

  it("recovers as the window slides past old entries", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const t0 = 1_000_000;

    // Fill the bucket at t0..t0+2
    for (let i = 0; i < 3; i++) {
      await backend.check({ key: "k", windowMs: 60_000, max: 3, now: t0 + i });
    }
    const denied = await backend.check({ key: "k", windowMs: 60_000, max: 3, now: t0 + 100 });
    expect(denied.allowed).toBe(false);

    // Move just past the last counted entry's window — all originals fall off.
    // Window ends at (t0+2) + 60_000 = t0 + 60_002, so check at t0 + 60_003.
    const recovered = await backend.check({
      key: "k",
      windowMs: 60_000,
      max: 3,
      now: t0 + 60_003,
    });
    expect(recovered.allowed).toBe(true);
    expect(recovered.used).toBe(1); // only the new one is counted
  });

  it("returns a sane resetAtMs (oldest counted timestamp + window)", async () => {
    const backend = new InMemorySlidingWindowBackend();
    const t0 = 1_000_000;
    const r = await backend.check({ key: "k", windowMs: 60_000, max: 5, now: t0 });
    expect(r.resetAtMs).toBe(t0 + 60_000);
  });

  it("clear() empties everything", async () => {
    const backend = new InMemorySlidingWindowBackend();
    for (let i = 0; i < 3; i++) {
      await backend.check({ key: "k", windowMs: 60_000, max: 3, now: 1_000_000 + i });
    }
    backend.clear();
    const r = await backend.check({ key: "k", windowMs: 60_000, max: 3, now: 1_000_000 + 100 });
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(1);
  });
});
