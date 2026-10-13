import {
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
  type OperationCallOptions,
  type OperationClient,
} from '@sixthsummit/ship-angular/operations';
import {
  type CreateInfiniteQueryOptions,
  hashKey,
  type InfiniteData,
  infiniteQueryOptions,
} from '@tanstack/angular-query-experimental';
import type { ShipQueryReadContext } from '../finite/ship-query-context';
import { canonicalizeKeyValue } from '../keys/canonicalize-key-value';
import { createShipQueryKey } from '../keys/create-ship-query-key';
import type { ShipQueryKey, ShipQueryKeyValue } from '../keys/ship-query-key';
import { assertShipReadBinding, type ShipReadBinding } from '../keys/ship-read-binding';
import { executeRead } from '../read-executor/execute-read';
import type { ShipQueryEnvelope } from '../read-executor/ship-query-envelope';
import type { ShipQueryPagination } from './ship-query-pagination';

/** Freshness and selection only. The adapter owns keys, cursors, execution, and retries. */
export type ShipInfiniteQueryOptions<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TPageParam extends ShipQueryKeyValue,
  TSelected = InfiniteData<ShipQueryEnvelope<TContract, TId>, TPageParam>,
> = Pick<
  CreateInfiniteQueryOptions<
    ShipQueryEnvelope<TContract, TId>,
    Error,
    TSelected,
    ShipQueryKey,
    TPageParam
  >,
  | 'staleTime'
  | 'gcTime'
  | 'refetchOnMount'
  | 'refetchOnWindowFocus'
  | 'refetchOnReconnect'
  | 'select'
> & { readonly call?: OperationCallOptions };

const ALLOWED_OPTIONS = new Set([
  'call',
  'staleTime',
  'gcTime',
  'refetchOnMount',
  'refetchOnWindowFocus',
  'refetchOnReconnect',
  'select',
]);

/**
 * Build low-level options for native observers or imperative infinite prefetch.
 * Native observer signals need a captured-outcome scope guard. Prefer injectShipInfiniteQuery.
 * Native page fetches must use cancelRefetch:false to share concurrent requests.
 * Keep input, cursor values, and nested values immutable until settlement.
 * V1 page cursors must be JSON key values; null is supported and undefined is rejected.
 */
export function shipInfiniteQueryOptions<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TPageParam extends ShipQueryKeyValue,
  TSelected = InfiniteData<ShipQueryEnvelope<TContract, TId>, TPageParam>,
>(
  client: OperationClient<TContract>,
  binding: ShipReadBinding<TContract, TId>,
  input: InputOf<TContract, TId> | undefined,
  context: ShipQueryReadContext,
  pagination: ShipQueryPagination<TContract, TId, TPageParam>,
  options: ShipInfiniteQueryOptions<TContract, TId, TPageParam, TSelected> = {}
) {
  for (const name of Reflect.ownKeys(options)) {
    if (typeof name !== 'string' || !ALLOWED_OPTIONS.has(name))
      throw new TypeError(`Infinite query option ${String(name)} cannot be overridden`);
  }
  assertShipReadBinding(binding);
  if (
    !pagination ||
    !Object.hasOwn(pagination, 'initialPageParam') ||
    typeof pagination.getNextPageParam !== 'function' ||
    typeof pagination.buildInput !== 'function' ||
    (pagination.getPreviousPageParam !== undefined &&
      typeof pagination.getPreviousPageParam !== 'function')
  ) {
    throw new TypeError(
      'Infinite queries require initialPageParam, getNextPageParam, and buildInput'
    );
  }
  const initialPageParam = canonicalizeKeyValue(pagination.initialPageParam) as TPageParam;
  const { getNextPageParam, getPreviousPageParam, buildInput } = pagination;
  const capturedBinding = { ...binding };
  const scope = context.scope.capture();
  const { call, ...display } = options;
  const capturedCall = call === undefined ? undefined : { ...call, headers: { ...call.headers } };
  const baseKey =
    input === undefined
      ? createShipQueryKey(
          {
            ...binding,
            inputKey: (_input: undefined) => ['disabled', binding.operationId, initialPageParam],
          },
          undefined,
          scope,
          'infinite'
        )
      : createShipQueryKey(
          {
            ...binding,
            inputKey: (value: InputOf<TContract, TId>) => ({
              input: binding.inputKey(value),
              initialPageParam,
            }),
          },
          input,
          scope,
          'infinite'
        );
  const queryKey: ShipQueryKey =
    input === undefined
      ? Object.freeze([
          baseKey[0],
          baseKey[1],
          baseKey[2],
          baseKey[3],
          baseKey[4],
          baseKey[5],
          '',
          baseKey[7],
          baseKey[8],
        ])
      : baseKey;
  const defaults = context.queryClient.getDefaultOptions().queries as
    | ShipInfiniteQueryOptions<TContract, TId, TPageParam, TSelected>
    | undefined;
  return infiniteQueryOptions<
    ShipQueryEnvelope<TContract, TId>,
    Error,
    TSelected,
    ShipQueryKey,
    TPageParam
  >({
    staleTime: defaults?.staleTime ?? 30000,
    gcTime: defaults?.gcTime ?? 300000,
    refetchOnMount: defaults?.refetchOnMount ?? true,
    refetchOnWindowFocus: defaults?.refetchOnWindowFocus ?? true,
    refetchOnReconnect: defaults?.refetchOnReconnect ?? true,
    ...display,
    queryKey,
    queryKeyHashFn: hashKey,
    initialData: () => undefined,
    placeholderData: () => undefined,
    enabled: input !== undefined && context.scope.isCurrent(scope),
    retry: false,
    initialPageParam,
    getNextPageParam,
    ...(getPreviousPageParam === undefined ? {} : { getPreviousPageParam }),
    queryFn: ({ signal, pageParam }) => {
      if (input === undefined || !context.scope.isCurrent(scope))
        throw new OperationAbortedError('Query input or scope is disabled');
      // Validate returned cursors before the builder sends them through the operation client.
      canonicalizeKeyValue(pageParam);
      const pageInput = buildInput(input, pageParam as TPageParam);
      return executeRead({
        client,
        binding: capturedBinding,
        input: pageInput,
        scope,
        scopePort: context.scope,
        signal,
        etag: false,
        ...(capturedCall === undefined ? {} : { call: capturedCall }),
      });
    },
  });
}
