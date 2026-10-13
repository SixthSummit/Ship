import { computed, signal, untracked } from '@angular/core';
import {
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
  type OperationClient,
} from '@sixthsummit/ship-angular/operations';
import {
  type CreateQueryResult,
  injectQuery,
  type QueryObserverResult,
  type RefetchOptions,
} from '@tanstack/angular-query-experimental';
import type { ShipQueryScopeSnapshot } from '../keys/ship-query-key';
import type { ShipReadBinding } from '../keys/ship-read-binding';
import type { ShipQueryEnvelope } from '../read-executor/ship-query-envelope';
import { ScopedQueryError } from './scoped-query-error';
import type { ScopedQueryValue } from './scoped-query-value';
import type { ShipQueryReadContext } from './ship-query-context';
import { type ShipQueryOptions, shipQueryOptions } from './ship-query-options';

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
  status: 'pending',
  fetchStatus: 'idle',
});

/**
 * Project one native query observer through its captured identity boundary.
 * Hide previous identity outcomes synchronously, before Angular flushes observer effects.
 * Keep inputs immutable until settlement, as required by shipQueryOptions.
 */
export function injectShipQuery<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TSelected = ShipQueryEnvelope<TContract, TId>,
>(
  client: OperationClient<TContract>,
  binding: ShipReadBinding<TContract, TId>,
  input: () => InputOf<TContract, TId> | undefined,
  context: ShipQueryReadContext,
  options:
    | ShipQueryOptions<TContract, TId, TSelected>
    | (() => ShipQueryOptions<TContract, TId, TSelected>) = {}
): CreateQueryResult<TSelected, Error> {
  const startedScope = signal<ShipQueryScopeSnapshot>(context.scope.capture());
  const configured = computed(() => {
    const captured = context.scope.capture();
    const controls = typeof options === 'function' ? options() : options;
    const value = input();
    const result = shipQueryOptions(client, binding, value, context, controls);
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
        select: (envelope: ShipQueryEnvelope<TContract, TId>): ScopedQueryValue<TSelected> => {
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
  const native = injectQuery(() => configured().options);
  const nativeFields = native as unknown as Record<string, () => unknown>;
  const fieldNames = Reflect.ownKeys(native).filter(
    (name): name is string => typeof name === 'string' && name !== 'refetch'
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
  const refetch = async (
    controls?: RefetchOptions
  ): Promise<QueryObserverResult<TSelected, Error>> => {
    const captured = untracked(() => configured().captured);
    if (!untracked(() => configured().enabled))
      throw new OperationAbortedError('Query input or scope is disabled');
    try {
      const result = await native.refetch(controls);
      if (!context.scope.isCurrent(captured))
        throw new OperationAbortedError('Query scope is no longer current');
      return {
        ...project(result as unknown as Record<string, unknown>),
        refetch,
      } as QueryObserverResult<TSelected, Error>;
    } catch (error: unknown) {
      if (!context.scope.isCurrent(captured))
        throw new OperationAbortedError('Query scope is no longer current');
      if (error instanceof ScopedQueryError) throw error.original;
      throw error;
    }
  };
  return Object.freeze({
    ...Object.fromEntries(fieldNames.map(name => [name, computed(() => visible()[name])])),
    refetch,
  }) as CreateQueryResult<TSelected, Error>;
}
