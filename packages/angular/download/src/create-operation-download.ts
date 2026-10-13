import { computed, type Signal, signal } from '@angular/core';
import {
  abortableOperationDelay,
  createOperationCallScope,
  type DownloadOperationId,
  type ErrorCodeOf,
  failureFromResponse,
  type InputOf,
  OperationAbortedError,
  type OperationCallOptions,
  type OperationFailure,
  OperationPolicyError,
  type OperationRequestPolicy,
  type OperationRetryTiming,
  type OperationSuccessStatusOf,
  OperationTimeoutError,
  operationRetryDelay,
  ProtocolError,
  type ResponseMetadata,
  responseMetadataFromHeaders,
  shouldRetryOperationResponse,
  TransportError,
} from '@sixthsummit/ship-angular/operations';

import { ownDownloadStream } from './own-download-stream';

export type OperationDownloadRepresentation = 'blob' | 'arrayBuffer' | 'stream';

export type OperationDownloadBody<TRepresentation extends OperationDownloadRepresentation> =
  TRepresentation extends 'blob'
    ? Blob
    : TRepresentation extends 'arrayBuffer'
      ? ArrayBuffer
      : ReadableStream<Uint8Array>;

export interface OperationDownloadRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit | null;
}

export interface OperationDownloadBinding<
  TContract extends object,
  TId extends DownloadOperationId<TContract>,
> {
  /** Generated serializer. ShipAngular never reconstructs operation URLs or request bodies. */
  readonly request: (input: InputOf<TContract, TId>) => OperationDownloadRequest;
  readonly successStatuses: readonly OperationSuccessStatusOf<TContract, TId>[];
  readonly declaredErrors: readonly ErrorCodeOf<TContract, TId>[];
  readonly contentTypes?: readonly string[];
}

export interface OperationDownloadSuccess<TRepresentation extends OperationDownloadRepresentation> {
  readonly ok: true;
  readonly status: number;
  readonly data: OperationDownloadBody<TRepresentation>;
  readonly filename?: string;
  readonly headers: ResponseMetadata;
}

export type OperationDownloadResult<
  TContract extends object,
  TId extends DownloadOperationId<TContract>,
  TRepresentation extends OperationDownloadRepresentation,
> = OperationDownloadSuccess<TRepresentation> | OperationFailure<ErrorCodeOf<TContract, TId>>;

export type OperationDownloadStatus =
  | 'idle'
  | 'downloading'
  | 'complete'
  | 'failure'
  | 'error'
  | 'aborted';

export interface CreateOperationDownloadOptions<
  TRepresentation extends OperationDownloadRepresentation,
> {
  readonly representation: TRepresentation;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly retry?: OperationRetryTiming;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface OperationDownload<
  TContract extends object,
  TId extends DownloadOperationId<TContract>,
  TRepresentation extends OperationDownloadRepresentation,
> {
  readonly status: Signal<OperationDownloadStatus>;
  readonly pending: Signal<boolean>;
  readonly result: Signal<OperationDownloadResult<TContract, TId, TRepresentation> | undefined>;
  readonly value: Signal<OperationDownloadBody<TRepresentation> | undefined>;
  readonly failure: Signal<OperationFailure<ErrorCodeOf<TContract, TId>> | undefined>;
  readonly error: Signal<Error | undefined>;
  start(
    input: InputOf<TContract, TId>,
    callOptions?: OperationCallOptions
  ): Promise<OperationDownloadResult<TContract, TId, TRepresentation>>;
  cancel(): boolean;
  reset(): void;
  destroy(): void;
}

interface DownloadState<
  TContract extends object,
  TId extends DownloadOperationId<TContract>,
  TRepresentation extends OperationDownloadRepresentation,
> {
  readonly status: OperationDownloadStatus;
  readonly result?: OperationDownloadResult<TContract, TId, TRepresentation>;
  readonly error?: Error;
}

/** Create a stale-safe browser download capability over generated request metadata. */
export function createOperationDownload<
  TContract extends object,
  TId extends DownloadOperationId<TContract>,
  TRepresentation extends OperationDownloadRepresentation = 'blob',
>(
  policy: OperationRequestPolicy<TContract>,
  operation: TId,
  binding: OperationDownloadBinding<TContract, TId>,
  options: CreateOperationDownloadOptions<TRepresentation> = {
    representation: 'blob' as TRepresentation,
  }
): OperationDownload<TContract, TId, TRepresentation> {
  const state = signal<DownloadState<TContract, TId, TRepresentation>>({ status: 'idle' });
  let active: AbortController | undefined;
  let generation = 0;

  const start = async (
    input: InputOf<TContract, TId>,
    callOptions: OperationCallOptions = {}
  ): Promise<OperationDownloadResult<TContract, TId, TRepresentation>> => {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    generation += 1;
    const execution = generation;
    state.set({ status: 'downloading' });

    let scope: ReturnType<typeof createOperationCallScope> | undefined;
    let streaming = false;
    try {
      const request = serializeDownloadRequest(binding, input);
      const policyCall = policy.begin(operation, callOptions);
      scope = createOperationCallScope(
        [controller.signal, callOptions.signal, options.signal],
        callOptions.timeoutMs
      );
      scope.throwIfAborted();
      let attempt = 1;
      let retryAttempt = 1;
      while (true) {
        const prepared = await policyCall.prepare({
          attempt,
          signal: scope.signal,
          targetUrl: request.url,
        });
        scope.throwIfAborted();
        const response = await (options.fetch ?? fetch)(request.url, {
          method: request.method ?? 'GET',
          ...(request.body === undefined ? {} : { body: request.body }),
          headers: { ...(request.headers ?? {}), ...(prepared.headers ?? {}) },
          ...(prepared.credentials === undefined ? {} : { credentials: prepared.credentials }),
          signal: scope.signal,
          redirect: 'error',
        });
        scope.throwIfAborted();
        if (response.status === 304) {
          throw new ProtocolError('Download cannot resolve a 304 response without cached bytes', {
            reason: 'unexpected-status',
            status: response.status,
            metadata: responseMetadataFromHeaders(response.headers),
          });
        }
        if (!response.ok) {
          const failure = await failureFromResponse(response, binding.declaredErrors);
          if (await policyCall.refreshAuthentication(failure.status, attempt, scope.signal)) {
            attempt += 1;
            continue;
          }
          if (
            shouldRetryOperationResponse(
              failure,
              policyCall.executionPolicy,
              callOptions.idempotencyKey,
              retryAttempt
            )
          ) {
            const delayMs = operationRetryDelay(
              failure.headers.retryAfterMs,
              retryAttempt,
              options.retry
            );
            await (options.delay ?? abortableOperationDelay)(delayMs, scope.signal);
            retryAttempt += 1;
            attempt += 1;
            continue;
          }
          if (execution === generation) state.set({ status: 'failure', result: failure });
          return failure;
        }
        if (
          !binding.successStatuses.includes(
            response.status as OperationSuccessStatusOf<TContract, TId>
          )
        ) {
          throw new ProtocolError('Download returned an undeclared success status', {
            reason: 'unexpected-status',
            status: response.status,
            metadata: responseMetadataFromHeaders(response.headers),
          });
        }

        const metadata = responseMetadataFromHeaders(response.headers);
        validateContentType(metadata.contentType, binding.contentTypes, response.status, metadata);
        let data = await readDownloadBody(response, options.representation);
        scope.throwIfAborted();
        if (options.representation === 'stream') {
          data = ownDownloadStream(
            data as ReadableStream<Uint8Array>,
            scope,
            () => controller.abort(),
            error => {
              if (execution !== generation) return;
              active = undefined;
              if (error === undefined) state.set({ status: 'complete', result });
              else {
                const normalized = normalizeDownloadError(error, scope?.abortError());
                state.set({
                  status: normalized instanceof OperationAbortedError ? 'aborted' : 'error',
                  error: normalized,
                });
              }
            }
          ) as OperationDownloadBody<TRepresentation>;
          streaming = true;
        }
        const filename = filenameFromDisposition(metadata.contentDisposition);
        const result: OperationDownloadSuccess<TRepresentation> = {
          ok: true,
          status: response.status,
          data,
          ...(filename === undefined ? {} : { filename }),
          headers: metadata,
        };
        if (execution === generation)
          state.set({ status: streaming ? 'downloading' : 'complete', result });
        return result;
      }
    } catch (caught: unknown) {
      const error = normalizeDownloadError(caught, scope?.abortError());
      if (execution === generation) {
        state.set({
          status: error instanceof OperationAbortedError ? 'aborted' : 'error',
          error,
        });
      }
      throw error;
    } finally {
      if (!streaming) {
        scope?.cleanup();
        if (execution === generation) active = undefined;
      }
    }
  };

  const result = computed(() => state().result);
  return {
    status: computed(() => state().status),
    pending: computed(() => state().status === 'downloading'),
    result,
    value: computed(() => {
      const current = result();
      return current?.ok ? current.data : undefined;
    }),
    failure: computed(() => {
      const current = result();
      return current !== undefined && !current.ok
        ? (current as OperationFailure<ErrorCodeOf<TContract, TId>>)
        : undefined;
    }),
    error: computed(() => state().error),
    start,
    cancel: () => {
      if (active === undefined) return false;
      active.abort();
      return true;
    },
    reset: () => {
      active?.abort();
      active = undefined;
      generation += 1;
      state.set({ status: 'idle' });
    },
    destroy: () => {
      active?.abort();
      active = undefined;
      generation += 1;
      state.set({ status: 'aborted', error: new OperationAbortedError() });
    },
  };
}

function serializeDownloadRequest<
  TContract extends object,
  TId extends DownloadOperationId<TContract>,
>(
  binding: OperationDownloadBinding<TContract, TId>,
  input: InputOf<TContract, TId>
): OperationDownloadRequest {
  try {
    return binding.request(input);
  } catch {
    throw new ProtocolError('The generated download request serializer failed', {
      reason: 'invalid-envelope',
    });
  }
}

async function readDownloadBody<TRepresentation extends OperationDownloadRepresentation>(
  response: Response,
  representation: TRepresentation
): Promise<OperationDownloadBody<TRepresentation>> {
  if (representation === 'blob') {
    return (await response.blob()) as OperationDownloadBody<TRepresentation>;
  }
  if (representation === 'arrayBuffer') {
    return (await response.arrayBuffer()) as OperationDownloadBody<TRepresentation>;
  }
  if (response.body === null) {
    throw new ProtocolError('Download response did not include a stream body', {
      reason: 'invalid-envelope',
      status: response.status,
      metadata: responseMetadataFromHeaders(response.headers),
    });
  }
  return response.body as OperationDownloadBody<TRepresentation>;
}

function validateContentType(
  received: string | undefined,
  allowed: readonly string[] | undefined,
  status: number,
  metadata: ResponseMetadata
): void {
  if (allowed === undefined || allowed.length === 0) return;
  const mime = received?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== undefined && allowed.some(candidate => candidate.toLowerCase() === mime)) return;
  throw new ProtocolError('Download content type was not declared by the operation', {
    reason: 'unexpected-content-type',
    status,
    metadata,
    ...(received === undefined ? {} : { receivedContentType: received }),
  });
}

export function filenameFromDisposition(disposition: string | undefined): string | undefined {
  if (disposition === undefined) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  let filename = plain;
  if (encoded !== undefined) {
    try {
      filename = decodeURIComponent(encoded);
    } catch {
      filename = encoded;
    }
  }
  const segments = filename?.split('\\').join('/').split('/');
  return segments?.[segments.length - 1]?.trim() || undefined;
}

function normalizeDownloadError(
  error: unknown,
  abortError: OperationAbortedError | OperationTimeoutError | undefined
): Error {
  if (abortError !== undefined) return abortError;
  if (
    error instanceof ProtocolError ||
    error instanceof TransportError ||
    error instanceof OperationPolicyError
  ) {
    return error;
  }
  return new TransportError('The download transport failed', {
    reason: 'network',
    causeName: errorName(error),
  });
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'UnknownError';
  return typeof error.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
}
