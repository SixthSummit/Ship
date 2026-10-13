import { describe, expect, it, vi } from "vitest";
import { defineRepositoryProjections } from "./projections.js";

describe("defineRepositoryProjections", () => {
  it("runs only declared functions and preserves deterministic names", async () => {
    const summary = vi.fn(async (id: string) => ({ id, name: "Ada" }));
    const detail = vi.fn((id: string, includeSecret: boolean) => ({ id, includeSecret }));
    const projections = defineRepositoryProjections({ summary, detail });

    await expect(projections.run("summary", "record-1")).resolves.toEqual({
      id: "record-1",
      name: "Ada",
    });
    expect(projections.run("detail", "record-2", true)).toEqual({
      id: "record-2",
      includeSecret: true,
    });
    expect(projections.names).toEqual(["detail", "summary"]);
    expect(projections.has("summary")).toBe(true);
    expect(projections.has("missing")).toBe(false);
    expect(Object.isFrozen(projections)).toBe(true);
    expect(Object.isFrozen(projections.names)).toBe(true);
  });

  it("rejects an undeclared dynamic projection with a stable diagnostic", () => {
    const projections = defineRepositoryProjections({ summary: () => ({ id: "record-1" }) });
    const run = projections.run as (name: string) => unknown;

    expect(() => run("secretDump")).toThrowError(
      expect.objectContaining({
        code: "SHIP_DRIZZLE_PROJECTION_UNKNOWN",
        projection: "secretDump",
      }),
    );
  });

  it.each([
    [null, undefined],
    [{}, undefined],
    [{ "Bad Name": () => undefined }, "Bad Name"],
    [{ summary: true }, "summary"],
  ])("rejects invalid projection definitions %#", (definitions, projection) => {
    const define = defineRepositoryProjections as (definitions: unknown) => unknown;
    expect(() => define(definitions)).toThrowError(
      expect.objectContaining({
        code: "SHIP_DRIZZLE_PROJECTIONS_INVALID",
        projection,
      }),
    );
  });
});
