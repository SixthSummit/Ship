import type { ShipQueryFreshness } from './ship-query-config';

/** Validate defaults even when JavaScript callers bypass the restricted type. */
export function resolveShipQueryFreshness(
  freshness: ShipQueryFreshness | undefined
): Required<ShipQueryFreshness> {
  const allowed = new Set([
    'staleTime',
    'gcTime',
    'refetchOnMount',
    'refetchOnWindowFocus',
    'refetchOnReconnect',
  ]);
  if (freshness !== undefined) {
    if (!freshness || typeof freshness !== 'object' || Array.isArray(freshness)) {
      throw new TypeError('Ship query freshness must be an options object.');
    }
    for (const key of Reflect.ownKeys(freshness)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        throw new TypeError('Ship query freshness cannot override adapter-owned options.');
      }
      if (Reflect.get(freshness, key) === null) {
        throw new TypeError('Ship query freshness values must not be null.');
      }
    }
  }
  const result: Required<ShipQueryFreshness> = {
    staleTime: freshness?.staleTime ?? 30000,
    gcTime: freshness?.gcTime ?? 300000,
    refetchOnMount: freshness?.refetchOnMount ?? true,
    refetchOnWindowFocus: freshness?.refetchOnWindowFocus ?? true,
    refetchOnReconnect: freshness?.refetchOnReconnect ?? true,
  };
  for (const time of [result.staleTime, result.gcTime]) {
    if (typeof time !== 'number' || Number.isNaN(time) || time < 0) {
      throw new TypeError('Ship query freshness times must be non-negative numbers.');
    }
  }
  for (const trigger of [
    result.refetchOnMount,
    result.refetchOnWindowFocus,
    result.refetchOnReconnect,
  ]) {
    if (typeof trigger !== 'boolean' && trigger !== 'always') {
      throw new TypeError('Ship query refetch defaults must be boolean or always.');
    }
  }
  return Object.freeze(result);
}
