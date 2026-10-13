import { computed, signal, untracked } from '@angular/core';
import {
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
  type OperationClient,
} from '@sixthsummit/ship-angular/operations';
import {
  type FetchNextPageOptions,
  type FetchPreviousPageOptions,
  type InfiniteData,
  type InfiniteQueryObserverResult,
  injectInfiniteQuery,
  type RefetchOptions,
} from '@tanstack/angular-query-experimental';
import { ScopedQueryError } from '../finite/scoped-query-error';
import type { ScopedQueryValue } from '../finite/scoped-query-value';
import type { ShipQueryReadContext } from '../finite/ship-query-context';
import type { ShipQueryKeyValue, ShipQueryScopeSnapshot } from '../keys/ship-query-key';
import type { ShipReadBinding } from '../keys/ship-read-binding';
import type { ShipQueryEnvelope } from '../read-executor/ship-query-envelope';
import {
  type ShipInfiniteQueryOptions,
  shipInfiniteQueryOptions,
} from './ship-infinite-query-options';
import type { ShipInfiniteQueryResult } from './ship-infinite-query-result';
import type { ShipQueryPagination } from './ship-query-pagination';

const HIDDEN_QUERY_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({
  data: undefined,
  dataUpdatedAt: 0,
  error: null,
  errorUpdatedAt: 0,
  failureCount: 0,
  failureReason: null,
  errorUpdateCount: 0,
  isError: false,
  isFetched: false,
  isFetchedAfterMount: false,
  isFetching: false,
  isLoading: false,
  isPending: true,
  isLoadingError: false,
  isInitialLoading: false,
  isPaused: false,
  isPlaceholderData: false,
  isRefetchError: false,
  isRefetching: false,
  isStale: true,
  isSuccess: false,
  isEnabled: false,
  hasNextPage: false,
  hasPreviousPage: false,
  isFetchingNextPage: false,
  isFetchingPreviousPage: false,
  isFetchNextPageError: false,
  isFetchPreviousPageError: false,
  status: 'pending',
  fetchStatus: 'idle',
});

/**
 * Project one native query observer through its captured identity boundary.
 * Hide previous identity outcomes synchronously, before Angular flushes observer effects.
 * Keep inputs immutable until settlement, as required by shipInfiniteQueryOptions.
 */
export function injectShipInfiniteQuery<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TPageParam extends ShipQueryKeyValue,
  TSelected = InfiniteData<ShipQueryEnvelope<TContract, TId>, TPageParam>,
>(
  client: OperationClient<TContract>,
  binding: ShipReadBinding<TContract, TId>,
  input: () => InputOf<TContract, TId> | undefined,
  context: ShipQueryReadContext,
  pagination: ShipQueryPagination<TContract, TId, TPageParam>,
  options:
    | ShipInfiniteQueryOptions<TContract, TId, TPageParam, TSelected>
    | (() => ShipInfiniteQueryOptions<TContract, TId, TPageParam, TSelected>) = {}
): ShipInfiniteQueryResult<TSelected> {
  const startedScope = signal<ShipQueryScopeSnapshot>(context.scope.capture());
  const configured = computed(() => {
    const captured = context.scope.capture();
    const controls = typeof options === 'function' ? options() : options;
    const value = input();
    const result = shipInfiniteQueryOptions(client, binding, value, context, pagination, controls);
    const select = controls.select;
    const queryFn = result.queryFn;
    return {
      captured,
      enabled: value !== undefined && context.scope.isCurrent(captured),
      options: {
        ...result,
        queryFn: async (request: Parameters<Exclude<typeof queryFn, undefined>>[0]) => {
          startedScope.set(captured);
          try {
            if (queryFn === undefined) throw new Error('Ship query function is missing');
            return await queryFn(request);
          } catch (error: unknown) {
            throw new ScopedQueryError(captured, error);
          }
        },
        select: (
          envelope: InfiniteData<ShipQueryEnvelope<TContract, TId>, TPageParam>
        ): ScopedQueryValue<TSelected> => {
          try {
            return {
              scope: captured,
              value: select === undefined ? (envelope as TSelected) : select(envelope),
            };
          } catch (error: unknown) {
            throw new ScopedQueryError(captured, error);
          }
        },
      },
    };
  });
  const native = injectInfiniteQuery(() => configured().options);
  const nativeFields = native as unknown as Record<string, () => unknown>;
  const fieldNames = Reflect.ownKeys(native).filter(
    (name): name is string =>
      typeof name === 'string' && !['refetch', 'fetchNextPage', 'fetchPreviousPage'].includes(name)
  );

  const project = (result: Record<string, unknown>): Record<string, unknown> => {
    const active = configured();
    const data = result.data as ScopedQueryValue<TSelected> | undefined;
    const error = result.error;
    const failure = result.failureReason;
    const outcomeScope =
      error instanceof ScopedQueryError
        ? error.scope
        : (data?.scope ?? (failure instanceof ScopedQueryError ? failure.scope : startedScope()));
    if (!active.enabled || outcomeScope === undefined || !context.scope.isCurrent(outcomeScope)) {
      return HIDDEN_QUERY_FIELDS;
    }
    return {
      ...result,
      data: data?.value,
      error: error instanceof ScopedQueryError ? error.original : error,
      failureReason: failure instanceof ScopedQueryError ? failure.original : failure,
    };
  };
  const visible = computed(() =>
    project(Object.fromEntries(fieldNames.map(name => [name, nativeFields[name]?.()])))
  );
  const invoke = async (
    method: 'refetch' | 'fetchNextPage' | 'fetchPreviousPage',
    controls?: RefetchOptions
  ): Promise<InfiniteQueryObserverResult<TSelected, Error>> => {
    for (const name of Reflect.ownKeys(controls ?? {})) {
      if (name !== 'throwOnError')
        throw new TypeError(`Infinite query fetch option ${String(name)} cannot be overridden`);
    }
    const captured = untracked(() => configured().captured);
    if (!untracked(() => configured().enabled))
      throw new OperationAbortedError('Query input or scope is disabled');
    try {
      // The native engine shares an existing page fetch when cancelRefetch is false.
      const result = await native[method]({ ...controls, cancelRefetch: false });
      if (!context.scope.isCurrent(captured))
        throw new OperationAbortedError('Query scope is no longer current');
      return {
        ...project(result as unknown as Record<string, unknown>),
        refetch,
        fetchNextPage,
        fetchPreviousPage,
      } as unknown as InfiniteQueryObserverResult<TSelected, Error>;
    } catch (error: unknown) {
      if (!context.scope.isCurrent(captured))
        throw new OperationAbortedError('Query scope is no longer current');
      if (error instanceof ScopedQueryError) throw error.original;
      throw error;
    }
  };
  const refetch = (controls?: Omit<RefetchOptions, 'cancelRefetch'>) => invoke('refetch', controls);
  const fetchNextPage = (controls?: Omit<FetchNextPageOptions, 'cancelRefetch'>) =>
    invoke('fetchNextPage', controls);
  const fetchPreviousPage = (controls?: Omit<FetchPreviousPageOptions, 'cancelRefetch'>) =>
    invoke('fetchPreviousPage', controls);
  return Object.freeze({
    ...Object.fromEntries(fieldNames.map(name => [name, computed(() => visible()[name])])),
    refetch,
    fetchNextPage,
    fetchPreviousPage,
  }) as unknown as ShipInfiniteQueryResult<TSelected>;
}
