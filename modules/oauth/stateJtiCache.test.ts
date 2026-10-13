import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStateJtiCache } from "./stateJtiCache.js";

describe("InMemoryStateJtiCache (F16)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false on first sighting, true on replay within TTL", () => {
    const cache = new InMemoryStateJtiCache();
    expect(cache.seenAndRecord("jti-1")).toBe(false);
    expect(cache.seenAndRecord("jti-1")).toBe(true);
  });

  it("distinct JTIs don't interfere", () => {
    const cache = new InMemoryStateJtiCache();
    expect(cache.seenAndRecord("jti-1")).toBe(false);
    expect(cache.seenAndRecord("jti-2")).toBe(false);
    expect(cache.seenAndRecord("jti-1")).toBe(true);
    expect(cache.seenAndRecord("jti-2")).toBe(true);
  });

  it("accepts a JTI again once its TTL has elapsed (default 60s)", () => {
    const cache = new InMemoryStateJtiCache();
    expect(cache.seenAndRecord("jti-1")).toBe(false);
    // Just inside TTL — still replay.
    vi.advanceTimersByTime(59_000);
    expect(cache.seenAndRecord("jti-1")).toBe(true);
    // Past TTL — accept again.
    vi.advanceTimersByTime(2_000);
    expect(cache.seenAndRecord("jti-1")).toBe(false);
  });

  it("custom ttlMs is honored", () => {
    const cache = new InMemoryStateJtiCache();
    expect(cache.seenAndRecord("jti-1", 1_000)).toBe(false);
    vi.advanceTimersByTime(500);
    expect(cache.seenAndRecord("jti-1", 1_000)).toBe(true);
    vi.advanceTimersByTime(700);
    expect(cache.seenAndRecord("jti-1", 1_000)).toBe(false);
  });

  it("prunes expired entries opportunistically so memory doesn't grow without bound", () => {
    const cache = new InMemoryStateJtiCache();
    for (let i = 0; i < 100; i++) {
      cache.seenAndRecord(`jti-${i}`);
    }
    expect(cache._size()).toBe(100);

    // Advance past TTL + the internal prune interval.
    vi.advanceTimersByTime(120_000);
    // Any call after the prune window prunes.
    cache.seenAndRecord("trigger");
    expect(cache._size()).toBeLessThan(100);
  });

  it("CAS semantics: 50 concurrent seenAndRecord(same jti) yields exactly one false", () => {
    const cache = new InMemoryStateJtiCache();
    const results = Array.from({ length: 50 }, () => cache.seenAndRecord("race"));
    expect(results.filter((r) => r === false)).toHaveLength(1);
    expect(results.filter((r) => r === true)).toHaveLength(49);
  });
});
