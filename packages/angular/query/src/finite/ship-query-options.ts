import {
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
  type OperationCallOptions,
  type OperationClient,
} from '@sixthsummit/ship-angular/operations';
import {
  type CreateQueryOptions,
  hashKey,
  queryOptions,
} from '@tanstack/angular-query-experimental';
import { createShipQueryKey } from '../keys/create-ship-query-key';
import type { ShipQueryKey } from '../keys/ship-query-key';
import { assertShipReadBinding, type ShipReadBinding } from '../keys/ship-read-binding';
import { executeRead } from '../read-executor/execute-read';
import type { ShipQueryEnvelope } from '../read-executor/ship-query-envelope';
import type { ShipQueryReadContext } from './ship-query-context';

/** Applications can adjust freshness and selection without replacing identity or execution. */
export type ShipQueryOptions<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TSelected = ShipQueryEnvelope<TContract, TId>,
> = Pick<
  CreateQueryOptions<ShipQueryEnvelope<TContract, TId>, Error, TSelected, ShipQueryKey>,
  | 'staleTime'
  | 'gcTime'
  | 'refetchOnMount'
  | 'refetchOnWindowFocus'
  | 'refetchOnReconnect'
  | 'select'
> & {
  readonly call?: OperationCallOptions;
};

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
 * Build low-level options for prefetch or an advanced native query factory.
 * Native observers can retain previous outcomes until Angular flushes their effects.
 * Guard their public signals with the captured outcome scope, or use injectShipQuery.
 * Keep the input and nested input values immutable until the request settles.
 * Generated codecs own input serialization; this adapter does not clone arbitrary codec values.
 */
export function shipQueryOptions<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TSelected = ShipQueryEnvelope<TContract, TId>,
>(
  client: OperationClient<TContract>,
  binding: ShipReadBinding<TContract, TId>,
  input: InputOf<TContract, TId> | undefined,
  context: ShipQueryReadContext,
  options: ShipQueryOptions<TContract, TId, TSelected> = {}
) {
  for (const name of Reflect.ownKeys(options)) {
    if (typeof name !== 'string' || !ALLOWED_OPTIONS.has(name)) {
      throw new TypeError(`Query option ${String(name)} cannot be overridden`);
    }
  }
  assertShipReadBinding(binding);
  const capturedBinding = { ...binding };
  const scope = context.scope.capture();
  const { call, ...display } = options;
  const capturedCall = call === undefined ? undefined : { ...call, headers: { ...call.headers } };
  // The empty operation ID is reserved. A real binding cannot produce this cache key.
  const baseKey =
    input === undefined
      ? createShipQueryKey(
          { ...binding, inputKey: (_input: undefined) => ['disabled', binding.operationId] },
          undefined,
          scope,
          'finite'
        )
      : createShipQueryKey(binding, input, scope, 'finite');
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
  // Freshness callbacks receive native queries. Only freshness fields are read from defaults.
  const defaults = context.queryClient.getDefaultOptions().queries as
    | ShipQueryOptions<TContract, TId, TSelected>
    | undefined;
  const enabled = input !== undefined && context.scope.isCurrent(scope);
  return queryOptions<ShipQueryEnvelope<TContract, TId>, Error, TSelected, ShipQueryKey>({
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
    enabled,
    retry: false,
    queryFn: ({ signal }) => {
      if (input === undefined || !context.scope.isCurrent(scope)) {
        throw new OperationAbortedError('Query input or scope is disabled');
      }
      const previous =
        context.queryClient.getQueryData<ShipQueryEnvelope<TContract, TId>>(queryKey);
      return executeRead({
        client,
        binding: capturedBinding,
        input,
        scope,
        scopePort: context.scope,
        signal,
        ...(capturedCall === undefined ? {} : { call: capturedCall }),
        ...(previous === undefined ? {} : { previous }),
      });
    },
  });
}
