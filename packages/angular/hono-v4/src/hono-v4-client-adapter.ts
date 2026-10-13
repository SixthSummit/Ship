import {
  type ErrorCodeOf,
  failureFromResponse,
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
  type OperationCallOptions,
  type OperationClient,
  type OperationDataOf,
  OperationPolicyError,
  type OperationResultOf,
  type OperationSuccessStatusOf,
  OperationTimeoutError,
  ProtocolError,
  responseMetadataFromHeaders,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { HonoV4CompatibilityError } from './hono-v4-compatibility-error';

export type HonoV4CancellationMode = 'forwarded' | 'discard-only';

export interface HonoV4OperationBinding<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
> {
  /** Consumer-owned bridge to its concrete `hc<typeof app>` route-tree call. */
  readonly invoke: (
    input: InputOf<TContract, TId>,
    options: OperationCallOptions
  ) => Promise<Response>;
  /** Runtime allowlist copied/generated from the legacy endpoint's declared error contract. */
  readonly declaredErrors: readonly ErrorCodeOf<TContract, TId>[];
  /** Runtime allowlist used to reject accidental endpoint/mapping drift. */
  readonly successStatuses: readonly OperationSuccessStatusOf<TContract, TId>[];
  /** Browser-safe decoder or schema parser for a successful JSON body. */
  readonly decodeSuccess: (
    value: unknown,
    status: OperationSuccessStatusOf<TContract, TId>
  ) => OperationDataOf<TContract, TId> | Promise<OperationDataOf<TContract, TId>>;
  /** `discard-only` suppresses stale publication but cannot stop the legacy network request. */
  readonly cancellation: HonoV4CancellationMode;
}

export type HonoV4OperationBindings<TContract extends object> = Partial<{
  [TId in HttpOperationId<TContract>]: HonoV4OperationBinding<TContract, TId>;
}>;

export interface HonoV4CompatibilityCapability {
  readonly mapped: boolean;
  readonly cancellation?: HonoV4CancellationMode;
}

/**
 * Temporary structural adapter for application-owned Hono v4 clients.
 *
 * This package deliberately has no Hono import. Route-tree types and calls stay in the app's
 * mapping, while Angular consumers receive the target operation result/resource semantics.
 */
export class HonoV4ClientAdapter<TContract extends object> implements OperationClient<TContract> {
  private readonly bindings: HonoV4OperationBindings<TContract>;

  constructor(bindings: HonoV4OperationBindings<TContract>) {
    this.bindings = bindings;
  }

  compatibility<TId extends HttpOperationId<TContract>>(
    operation: TId
  ): HonoV4CompatibilityCapability {
    const binding = this.bindings[operation];
    return binding === undefined
      ? { mapped: false }
      : { mapped: true, cancellation: binding.cancellation };
  }

  async call<TId extends HttpOperationId<TContract>>(
    operation: TId,
    input: InputOf<TContract, TId>,
    options: OperationCallOptions = {}
  ): Promise<OperationResultOf<TContract, TId>> {
    const binding = this.bindings[operation] as HonoV4OperationBinding<TContract, TId> | undefined;
    if (binding === undefined) {
      throw new HonoV4CompatibilityError(`No Hono v4 mapping exists for ${operation}`, {
        reason: 'missing-operation-mapping',
        operation,
      });
    }
    if (options.signal?.aborted) throw new OperationAbortedError();

    let response: Response;
    try {
      response = await awaitWithAbort(binding.invoke(input, options), options.signal);
    } catch (error: unknown) {
      if (options.signal?.aborted) throw new OperationAbortedError();
      if (isOperationException(error)) throw error;
      throw new TransportError('The Hono v4 operation request failed', {
        reason: 'network',
        causeName: errorName(error),
      });
    }

    const metadata = responseMetadataFromHeaders(response.headers);
    if (response.status === 304) {
      return {
        ok: true,
        notModified: true,
        status: 304,
        headers: metadata,
      } as OperationResultOf<TContract, TId>;
    }
    if (!response.ok) {
      return (await failureFromResponse(response, binding.declaredErrors)) as OperationResultOf<
        TContract,
        TId
      >;
    }
    if (
      !binding.successStatuses.includes(response.status as OperationSuccessStatusOf<TContract, TId>)
    ) {
      throw new HonoV4CompatibilityError(
        `Hono v4 mapping for ${operation} received undeclared success status ${response.status}`,
        {
          reason: 'unsupported-success-status',
          operation,
          status: response.status,
        }
      );
    }

    const status = response.status as OperationSuccessStatusOf<TContract, TId>;
    let data: OperationDataOf<TContract, TId>;
    if (status === 204) {
      data = undefined as OperationDataOf<TContract, TId>;
    } else {
      const contentType = response.headers.get('content-type');
      if (!contentType?.toLowerCase().includes('json')) {
        throw new ProtocolError('Expected a JSON Hono v4 success response', {
          reason: 'unexpected-content-type',
          status,
          metadata,
          ...(contentType === null ? {} : { receivedContentType: contentType }),
        });
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProtocolError('The Hono v4 success response was not valid JSON', {
          reason: 'invalid-json',
          status,
          metadata,
          receivedContentType: contentType,
        });
      }
      try {
        data = await binding.decodeSuccess(body, status);
      } catch (error: unknown) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError('The Hono v4 success response failed its client decoder', {
          reason: 'invalid-envelope',
          status,
          metadata,
          receivedContentType: contentType,
        });
      }
    }

    return { ok: true, status, data, headers: metadata } as OperationResultOf<TContract, TId>;
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OperationAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function isOperationException(error: unknown): error is Error {
  return (
    error instanceof OperationAbortedError ||
    error instanceof OperationTimeoutError ||
    error instanceof OperationPolicyError ||
    error instanceof ProtocolError ||
    error instanceof TransportError ||
    error instanceof HonoV4CompatibilityError
  );
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'UnknownError';
  return typeof error.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
}
