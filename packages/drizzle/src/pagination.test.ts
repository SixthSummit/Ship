import { describe, expect, it } from "vitest";
import { offsetPage, resolveOffsetPagination } from "./pagination.js";
import { DrizzleRepositoryError } from "./repository-error.js";

describe("repository pagination", () => {
  it("resolves immutable defaults and an explicit bounded window", () => {
    expect(resolveOffsetPagination()).toEqual({ limit: 50, offset: 0 });

    const window = resolveOffsetPagination(
      { limit: 20, offset: 40 },
      { defaultLimit: 10, maxLimit: 100 },
    );
    expect(window).toEqual({ limit: 20, offset: 40 });
    expect(Object.isFrozen(window)).toBe(true);
  });

  it("builds an immutable result without mutating the source rows", () => {
    const source = [{ id: "record-1" }, { id: "record-2" }];
    const page = offsetPage(source, 3, { limit: 2, offset: 0 });

    source.push({ id: "record-3" });
    expect(page).toEqual({
      items: [{ id: "record-1" }, { id: "record-2" }],
      total: 3,
      limit: 2,
      offset: 0,
      hasMore: true,
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(offsetPage([], 3, { limit: 2, offset: 4 }).hasMore).toBe(false);
  });

  it.each([
    [null, {}, undefined],
    [{}, null, undefined],
    [{ limit: 0 }, {}, "limit"],
    [{ limit: 1.5 }, {}, "limit"],
    [{ offset: -1 }, {}, "offset"],
    [{ limit: 11 }, { defaultLimit: 10, maxLimit: 10 }, "limit"],
    [{}, { defaultLimit: 11, maxLimit: 10 }, "defaultLimit"],
    [{}, { defaultLimit: 0 }, "defaultLimit"],
    [{}, { maxLimit: 0 }, "maxLimit"],
  ])("rejects invalid pagination input %#", (input, policy, field) => {
    const resolve = resolveOffsetPagination as (input: unknown, policy: unknown) => unknown;
    expect(() => resolve(input, policy)).toThrowError(
      expect.objectContaining({
        name: "DrizzleRepositoryError",
        code: "SHIP_DRIZZLE_PAGINATION_INVALID",
        field,
      }),
    );
  });

  it.each([
    [null, 0, { limit: 1, offset: 0 }, "items"],
    [[], -1, { limit: 1, offset: 0 }, "total"],
    [[], 0, null, "pagination"],
    [[], 0, { limit: 0, offset: 0 }, "limit"],
    [[], 0, { limit: 1, offset: -1 }, "offset"],
    [[1, 2], 2, { limit: 1, offset: 0 }, "items"],
  ])("rejects invalid page result input %#", (items, total, pagination, field) => {
    const build = offsetPage as (items: unknown, total: unknown, pagination: unknown) => unknown;
    expect(() => build(items, total, pagination)).toThrowError(
      expect.objectContaining({
        code: "SHIP_DRIZZLE_PAGE_RESULT_INVALID",
        field,
      }),
    );
  });

  it("uses one stable repository error type", () => {
    expect(() => resolveOffsetPagination({ limit: 201 })).toThrow(DrizzleRepositoryError);
  });
});
