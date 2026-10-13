import { nextOccurrence as reference } from "@sixthsummit/ship-testing/jobs";
import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./job-schedule.js";

const from = new Date("2026-09-18T12:34:56.000Z");

describe("nextOccurrence", () => {
  it("advances intervals from the given instant", () => {
    expect(nextOccurrence({ kind: "interval", everyMs: 1_500 }, from).toISOString()).toBe(
      "2026-09-18T12:34:57.500Z",
    );
  });

  it.each([
    ["* * * * *", "UTC"],
    ["*/15 * * * *", "UTC"],
    ["0 6 * * *", "America/New_York"],
    ["30 3 * * 1-5", "Europe/Berlin"],
    ["0 0 1 1 *", "Asia/Tokyo"],
    ["0 12 * * 0,6", "UTC"],
    ["5 4 * * sun".replace("sun", "0"), "UTC"],
    ["0 0 0 * * *", "UTC"],
  ])("agrees with the in-memory backend for %s in %s", (cron, tz) => {
    const trigger = { kind: "schedule" as const, cron, tz };
    let cursor = from;
    for (let index = 0; index < 5; index += 1) {
      const next = nextOccurrence(trigger, cursor);
      expect(next).toEqual(reference(trigger, cursor));
      expect(next.getTime()).toBeGreaterThan(cursor.getTime());
      cursor = next;
    }
  });

  it("rejects unsupported cron fields and expressions that never fire", () => {
    expect(() => nextOccurrence({ kind: "schedule", cron: "x * * * *", tz: "UTC" }, from)).toThrow(
      /unsupported cron field/u,
    );
    expect(() => nextOccurrence({ kind: "schedule", cron: "0 0 31 2 *", tz: "UTC" }, from)).toThrow(
      /no occurrence within a year/u,
    );
  });
});
