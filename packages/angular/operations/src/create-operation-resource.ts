import { computed, type ResourceStatus, resource, type Signal } from '@angular/core';
import { composeAbortSignals } from './compose-abort-signals';
import { OperationAbortedError } from './operation-aborted-error';
import type { OperationCallOptions, OperationClient } from './operation-client';
import type { HttpOperationId, InputOf } from './operation-contract';
import type { OperationDataOf, OperationFailureOf, OperationResultOf } from './operation-result';
import { ProtocolError } from './protocol-error';
import type { ResponseMetadata } from './response-metadata';

interface OperationResourceValue<TContract extends object, TId extends HttpOperationId<TContract>> {
  readonly data: OperationDataOf<TContract, TId> | undefined;
  readonly result: OperationResultOf<TContract, TId>;
}

interface OperationResourceCacheEntry<TData> {
  readonly etag: string;
  readonly data: TData;
}

export interface CreateOperationResourceOptions<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
> {
  /** Static controls for every load. Cancellation is composed with Angular's load scope. */
  readonly call?: OperationCallOptions;
  /** Opt-in conditional request cache. The caller supplies a stable, non-sensitive key. */
  readonly etag?: {
    readonly key: (input: InputOf<TContract, TId>) => string;
  };
}

/** Angular signal surface for one operation-backed read. */
export interface OperationResource<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
> {
  readonly value: Signal<OperationDataOf<TContract, TId> | undefined>;
  readonly result: Signal<OperationResultOf<TContract, TId> | undefined>;
  readonly failure: Signal<OperationFailureOf<TContract, TId> | undefined>;
  readonly metadata: Signal<ResponseMetadata | undefined>;
  readonly status: Signal<ResourceStatus>;
  readonly error: Signal<Error | undefined>;
  readonly isLoading: Signal<boolean>;
  reload(): boolean;
  destroy(): void;
}

/**
 * Create a signal-tracked read resource from an explicit stable operation ID and typed input.
 * Declared API failures remain values; only exceptional transport/protocol failures enter `error`.
 */
export function createOperationResource<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
>(
  client: OperationClient<TContract>,
  operation: TId,
  input: () => InputOf<TContract, TId> | undefined,
  options: CreateOperationResourceOptions<TContract, TId> = {}
): OperationResource<TContract, TId> {
  const cache = new Map<string, OperationResourceCacheEntry<OperationDataOf<TContract, TId>>>();
  const ref = resource<OperationResourceValue<TContract, TId>, InputOf<TContract, TId> | undefined>(
    {
      params: input,
      loader: async ({ params, abortSignal }) => {
        const cacheKey = options.etag?.key(params);
        const cached = cacheKey === undefined ? undefined : cache.get(cacheKey);
        const headers = {
          ...(options.call?.headers ?? {}),
          ...(cached === undefined ? {} : { 'if-none-match': cached.etag }),
        };
        const composed = composeAbortSignals([abortSignal, options.call?.signal]);
        try {
          const result = await client.call(operation, params, {
            ...options.call,
            headers,
            signal: composed.signal,
          });
          if (composed.signal.aborted) throw new OperationAbortedError();

          if (result.ok) {
            if (!('data' in result)) {
              if (cached === undefined) {
                throw new ProtocolError('Received 304 without a cached operation value', {
                  reason: 'unexpected-status',
                  status: result.status,
                  metadata: result.headers,
                });
              }
              return { data: cached.data, result };
            }

            const data = result.data as OperationDataOf<TContract, TId>;
            const etag = result.headers.etag;
            if (cacheKey !== undefined && etag !== undefined) {
              cache.set(cacheKey, { etag, data });
            }
            return { data, result };
          }

          return { data: undefined, result };
        } finally {
          composed.cleanup();
        }
      },
    }
  );

  const readableValue = computed(() => (ref.status() === 'error' ? undefined : ref.value()?.data));
  const readableResult = computed(() =>
    ref.status() === 'error' ? undefined : ref.value()?.result
  );
  const failure = computed(() => {
    const result = readableResult();
    return result !== undefined && !result.ok
      ? (result as OperationFailureOf<TContract, TId>)
      : undefined;
  });
  const metadata = computed(() => readableResult()?.headers);

  return {
    value: readableValue,
    result: readableResult,
    failure,
    metadata,
    status: ref.status,
    error: ref.error,
    isLoading: ref.isLoading,
    reload: () => ref.reload(),
    destroy: () => ref.destroy(),
  };
}
