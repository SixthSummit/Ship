import type { ShipQueryMode } from '../keys/ship-query-key';
import type { ShipQueryCacheData } from './ship-query-cache-data';

/** Reject async updaters and malformed envelope shapes when callers bypass static types. */
export function assertShipQueryCacheData(
  value: unknown,
  mode: ShipQueryMode
): asserts value is ShipQueryCacheData {
  if (!value || typeof value !== 'object' || 'then' in value) {
    throw new TypeError('Cache updates require synchronous query envelopes.');
  }
  if (mode === 'infinite') {
    if (
      !('pages' in value) ||
      !Array.isArray(value.pages) ||
      !('pageParams' in value) ||
      !Array.isArray(value.pageParams) ||
      value.pages.length !== value.pageParams.length
    ) {
      throw new TypeError('Infinite cache updates require aligned pages and pageParams.');
    }
    for (const page of value.pages) assertShipQueryCacheData(page, 'finite');
    return;
  }
  if (
    !Object.hasOwn(value, 'data') ||
    !('result' in value) ||
    !value.result ||
    typeof value.result !== 'object' ||
    !('ok' in value.result) ||
    value.result.ok !== true ||
    !('status' in value.result) ||
    typeof value.result.status !== 'number' ||
    !Number.isInteger(value.result.status) ||
    (value.result.status !== 304 && (value.result.status < 200 || value.result.status >= 300)) ||
    !('headers' in value.result) ||
    !value.result.headers ||
    typeof value.result.headers !== 'object' ||
    !('headers' in value.result.headers) ||
    !value.result.headers.headers ||
    typeof value.result.headers.headers !== 'object' ||
    ('etag' in value && typeof value.etag !== 'string')
  ) {
    throw new TypeError('Cache updates require a body envelope and its successful result.');
  }
}
