import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeNextAttempt, hasExhaustedRetries, isReadyForPublish } from "./schema.js";

const NOW = new Date("2025-06-01T00:00:00Z");

describe("outbox schema status helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isReadyForPublish", () => {
    it("false when status is not 'pending'", () => {
      expect(
        isReadyForPublish({
          status: "processing",
          publishedAt: null,
          nextAttemptAt: null,
        }),
      ).toBe(false);
      expect(
        isReadyForPublish({
          status: "published",
          publishedAt: null,
          nextAttemptAt: null,
        }),
      ).toBe(false);
      expect(
        isReadyForPublish({
          status: "failed",
          publishedAt: null,
          nextAttemptAt: null,
        }),
      ).toBe(false);
    });

    it("false when publishedAt is set (already published)", () => {
      expect(
        isReadyForPublish({
          status: "pending",
          publishedAt: new Date(NOW.getTime() - 60_000),
          nextAttemptAt: null,
        }),
      ).toBe(false);
    });

    it("false when nextAttemptAt is in the future (scheduled retry)", () => {
      expect(
        isReadyForPublish({
          status: "pending",
          publishedAt: null,
          nextAttemptAt: new Date(NOW.getTime() + 60_000),
        }),
      ).toBe(false);
    });

    it("true when status='pending' and no nextAttemptAt", () => {
      expect(
        isReadyForPublish({
          status: "pending",
          publishedAt: null,
          nextAttemptAt: null,
        }),
      ).toBe(true);
    });

    it("true when nextAttemptAt has already passed", () => {
      expect(
        isReadyForPublish({
          status: "pending",
          publishedAt: null,
          nextAttemptAt: new Date(NOW.getTime() - 60_000),
        }),
      ).toBe(true);
    });
  });

  describe("hasExhaustedRetries", () => {
    it("true when publishAttempts >= maxRetries", () => {
      expect(hasExhaustedRetries({ publishAttempts: 10, maxRetries: 10 })).toBe(true);
      expect(hasExhaustedRetries({ publishAttempts: 11, maxRetries: 10 })).toBe(true);
    });

    it("false when publishAttempts < maxRetries", () => {
      expect(hasExhaustedRetries({ publishAttempts: 0, maxRetries: 10 })).toBe(false);
      expect(hasExhaustedRetries({ publishAttempts: 9, maxRetries: 10 })).toBe(false);
    });
  });

  describe("computeNextAttempt", () => {
    it("first attempt: ~baseMs in the future", () => {
      const at = computeNextAttempt(1, 1_000);
      const delta = at.getTime() - Date.now();
      // ±20% jitter on 1000ms = [800, 1200]
      expect(delta).toBeGreaterThanOrEqual(800);
      expect(delta).toBeLessThanOrEqual(1200);
    });

    it("second attempt: ~2 * baseMs", () => {
      const at = computeNextAttempt(2, 1_000);
      const delta = at.getTime() - Date.now();
      expect(delta).toBeGreaterThanOrEqual(1600);
      expect(delta).toBeLessThanOrEqual(2400);
    });

    it("backoff caps at maxMs", () => {
      const at = computeNextAttempt(20, 1_000, 60_000);
      const delta = at.getTime() - Date.now();
      // 2^19 * 1000 == 524288000 ms — way over the 60s cap.
      // ±20% jitter on 60s = [48000, 72000]
      expect(delta).toBeGreaterThanOrEqual(48_000);
      expect(delta).toBeLessThanOrEqual(72_000);
    });

    it("attempt=0 (or negative) treated as 1 (no negative exponents)", () => {
      const at = computeNextAttempt(0, 1_000);
      const delta = at.getTime() - Date.now();
      expect(delta).toBeGreaterThanOrEqual(800);
      expect(delta).toBeLessThanOrEqual(1200);
    });
  });
});
