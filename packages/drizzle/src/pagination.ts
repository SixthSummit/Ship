import { DrizzleRepositoryError } from "./repository-error.js";

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_LIMIT = 200;

export interface OffsetPaginationInput {
  readonly limit?: number;
  readonly offset?: number;
}

export interface OffsetPaginationPolicy {
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
}

export interface OffsetPagination {
  readonly limit: number;
  readonly offset: number;
}

export interface OffsetPage<TItem> extends OffsetPagination {
  readonly items: readonly TItem[];
  readonly total: number;
  readonly hasMore: boolean;
}

/** Resolves one bounded limit/offset window without defining a wire format. */
export function resolveOffsetPagination(
  input: OffsetPaginationInput = {},
  policy: OffsetPaginationPolicy = {},
): OffsetPagination {
  assertRecord(input, "pagination input");
  assertRecord(policy, "pagination policy");

  const maxLimit = policy.maxLimit ?? DEFAULT_MAX_LIMIT;
  const defaultLimit = policy.defaultLimit ?? DEFAULT_LIMIT;
  assertPositiveSafeInteger(maxLimit, "maxLimit");
  assertPositiveSafeInteger(defaultLimit, "defaultLimit");
  if (defaultLimit > maxLimit) {
    throw paginationError("defaultLimit cannot exceed maxLimit", "defaultLimit");
  }

  const limit = input.limit ?? defaultLimit;
  const offset = input.offset ?? 0;
  assertPositiveSafeInteger(limit, "limit");
  assertNonNegativeSafeInteger(offset, "offset");
  if (limit > maxLimit) {
    throw paginationError(`limit cannot exceed ${maxLimit}`, "limit");
  }

  return Object.freeze({ limit, offset });
}

/** Builds an immutable page result from rows and the matching query count. */
export function offsetPage<TItem>(
  items: readonly TItem[],
  total: number,
  pagination: OffsetPagination,
): OffsetPage<TItem> {
  if (!Array.isArray(items)) {
    throw pageResultError("page items must be an array", "items");
  }
  assertNonNegativeSafeInteger(total, "total", pageResultError);
  if (typeof pagination !== "object" || pagination === null || Array.isArray(pagination)) {
    throw pageResultError("pagination must be an object", "pagination");
  }
  assertPositiveSafeInteger(pagination.limit, "limit", pageResultError);
  assertNonNegativeSafeInteger(pagination.offset, "offset", pageResultError);
  if (items.length > pagination.limit) {
    throw pageResultError("page item count cannot exceed its limit", "items");
  }

  const frozenItems = Object.freeze([...items]);
  return Object.freeze({
    items: frozenItems,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
    hasMore: pagination.offset + frozenItems.length < total,
  });
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw paginationError(`${name} must be an object`);
  }
}

function assertPositiveSafeInteger(
  value: unknown,
  field: string,
  error: (message: string, field?: string) => DrizzleRepositoryError = paginationError,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw error(`${field} must be a positive safe integer`, field);
  }
}

function assertNonNegativeSafeInteger(
  value: unknown,
  field: string,
  error: (message: string, field?: string) => DrizzleRepositoryError = paginationError,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw error(`${field} must be a non-negative safe integer`, field);
  }
}

function paginationError(message: string, field?: string): DrizzleRepositoryError {
  return new DrizzleRepositoryError("SHIP_DRIZZLE_PAGINATION_INVALID", message, { field });
}

function pageResultError(message: string, field?: string): DrizzleRepositoryError {
  return new DrizzleRepositoryError("SHIP_DRIZZLE_PAGE_RESULT_INVALID", message, { field });
}
