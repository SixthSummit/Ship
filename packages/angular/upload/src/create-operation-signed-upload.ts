import { computed, type Signal, signal } from '@angular/core';
import {
  createOperationCallScope,
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
  type OperationCallOptions,
  type OperationClient,
  type OperationDataOf,
  type OperationFailureOf,
  OperationPolicyError,
  type OperationSuccessOf,
  OperationTimeoutError,
  ProtocolError,
  type ResponseMetadata,
  responseMetadataFromHeaders,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import {
  type OperationUploadFieldConstraint,
  validateUploadFiles,
} from './create-operation-upload';
import { executeXhrUpload } from './execute-xhr-upload';
import { OperationUploadValidationError } from './operation-upload-validation-error';
import { SignedUploadProviderError } from './signed-upload-provider-error';

export interface SignedUploadDestination {
  /** Sensitive signed URL. It is used internally and never retained in public state. */
  readonly url: string;
  readonly method?: 'PUT' | 'POST' | 'PATCH';
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SignedUploadProviderResult {
  readonly status: number;
  readonly headers: ResponseMetadata;
}

export interface OperationSignedUploadCompletion<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
> {
  readonly operation: TId;
  readonly input: (context: {
    readonly file: File;
    readonly destination: SignedUploadDestination;
    readonly provider: SignedUploadProviderResult;
  }) => InputOf<TContract, TId>;
}

export interface OperationSignedUploadBinding<
  TContract extends object,
  TSignId extends HttpOperationId<TContract>,
  TCompleteId extends HttpOperationId<TContract> | never = never,
> {
  readonly sign: {
    readonly operation: TSignId;
    readonly input: (file: File) => InputOf<TContract, TSignId>;
    readonly destination: (
      data: OperationDataOf<TContract, TSignId>,
      file: File
    ) => SignedUploadDestination;
  };
  readonly file: OperationUploadFieldConstraint;
  readonly completion?: [TCompleteId] extends [never]
    ? never
    : OperationSignedUploadCompletion<TContract, TCompleteId>;
}

export type OperationSignedUploadStatus =
  | 'idle'
  | 'signing'
  | 'uploading'
  | 'completing'
  | 'complete'
  | 'failure'
  | 'error'
  | 'aborted';

export type OperationSignedUploadResult<
  TContract extends object,
  TSignId extends HttpOperationId<TContract>,
  TCompleteId extends HttpOperationId<TContract> | never = never,
> =
  | {
      readonly ok: true;
      readonly provider: SignedUploadProviderResult;
      readonly completion: [TCompleteId] extends [never]
        ? undefined
        : OperationSuccessOf<TContract, TCompleteId>;
    }
  | {
      readonly ok: false;
      readonly stage: 'sign';
      readonly result: OperationFailureOf<TContract, TSignId>;
    }
  | ([TCompleteId] extends [never]
      ? never
      : {
          readonly ok: false;
          readonly stage: 'complete';
          readonly result: OperationFailureOf<TContract, TCompleteId>;
        });

export interface OperationSignedUploadCallOptions {
  readonly sign?: OperationCallOptions;
  readonly complete?: OperationCallOptions;
}

export interface CreateOperationSignedUploadOptions {
  /** Exact provider origins permitted to receive the signed transfer. Required and non-empty. */
  readonly allowedProviderOrigins: readonly string[];
  readonly createXhr?: () => XMLHttpRequest;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface OperationSignedUpload<
  TContract extends object,
  TSignId extends HttpOperationId<TContract>,
  TCompleteId extends HttpOperationId<TContract> | never = never,
> {
  readonly status: Signal<OperationSignedUploadStatus>;
  readonly pending: Signal<boolean>;
  readonly progress: Signal<number>;
  readonly result: Signal<OperationSignedUploadResult<TContract, TSignId, TCompleteId> | undefined>;
  readonly error: Signal<Error | undefined>;
  start(
    file: File,
    options?: OperationSignedUploadCallOptions
  ): Promise<OperationSignedUploadResult<TContract, TSignId, TCompleteId>>;
  cancel(): boolean;
  reset(): void;
  destroy(): void;
}

interface SignedUploadState<
  TContract extends object,
  TSignId extends HttpOperationId<TContract>,
  TCompleteId extends HttpOperationId<TContract> | never,
> {
  readonly status: OperationSignedUploadStatus;
  readonly progress: number;
  readonly result?: OperationSignedUploadResult<TContract, TSignId, TCompleteId>;
  readonly error?: Error;
}

/** Execute sign, isolated provider transfer, and optional completion as one stale-safe flow. */
export function createOperationSignedUpload<
  TContract extends object,
  TSignId extends HttpOperationId<TContract>,
  TCompleteId extends HttpOperationId<TContract> | never = never,
>(
  client: OperationClient<TContract>,
  binding: OperationSignedUploadBinding<TContract, TSignId, TCompleteId>,
  options: CreateOperationSignedUploadOptions
): OperationSignedUpload<TContract, TSignId, TCompleteId> {
  const providerOrigins = normalizeProviderOrigins(options.allowedProviderOrigins);
  const state = signal<SignedUploadState<TContract, TSignId, TCompleteId>>({
    status: 'idle',
    progress: 0,
  });
  let activeController: AbortController | undefined;
  let activeXhr: XMLHttpRequest | undefined;
  let generation = 0;

  const start = async (
    file: File,
    callOptions: OperationSignedUploadCallOptions = {}
  ): Promise<OperationSignedUploadResult<TContract, TSignId, TCompleteId>> => {
    activeController?.abort();
    activeXhr?.abort();
    const controller = new AbortController();
    activeController = controller;
    generation += 1;
    const execution = generation;
    state.set({ status: 'signing', progress: 0 });
    const scope = createOperationCallScope(
      [controller.signal, callOptions.sign?.signal, callOptions.complete?.signal, options.signal],
      options.timeoutMs
    );
    try {
      validateUploadFiles([{ field: binding.file.field, file }], [binding.file]);
      scope.throwIfAborted();
      const signInput = serializeSignInput(binding, file);
      const signResult = await client.call(binding.sign.operation, signInput, {
        ...callOptions.sign,
        signal: scope.signal,
      });
      scope.throwIfAborted();
      if (!signResult.ok) {
        const result = {
          ok: false,
          stage: 'sign',
          result: signResult as OperationFailureOf<TContract, TSignId>,
        } as OperationSignedUploadResult<TContract, TSignId, TCompleteId>;
        if (execution === generation) state.set({ status: 'failure', progress: 0, result });
        return result;
      }
      if (signResult.notModified === true) {
        throw new ProtocolError('A signed upload request cannot use a cached 304 result', {
          reason: 'unexpected-status',
          status: 304,
          metadata: signResult.headers,
        });
      }
      const destination = resolveDestination(binding, signResult.data, file);
      assertProviderOrigin(destination.url, providerOrigins);
      if (execution === generation) state.set({ status: 'uploading', progress: 0 });
      const raw = await executeXhrUpload(
        {
          url: destination.url,
          method: destination.method ?? 'PUT',
          ...(destination.headers === undefined ? {} : { headers: destination.headers }),
          body: file,
          withCredentials: false,
        },
        {
          signal: scope.signal,
          ...(options.createXhr === undefined ? {} : { createXhr: options.createXhr }),
          onCreated: xhr => {
            if (execution === generation) activeXhr = xhr;
          },
          onProgress: value => {
            if (execution !== generation) return;
            state.set({ ...state(), progress: Math.max(state().progress, value) });
          },
        }
      );
      scope.throwIfAborted();
      const provider: SignedUploadProviderResult = {
        status: raw.status,
        headers: responseMetadataFromHeaders(raw.headers),
      };
      if (raw.status < 200 || raw.status >= 300) {
        throw new SignedUploadProviderError(raw.status, provider.headers);
      }

      let completion: OperationSuccessOf<TContract, TCompleteId> | undefined;
      if (binding.completion !== undefined) {
        if (execution === generation) {
          state.set({ status: 'completing', progress: 1 });
        }
        const completionInput = serializeCompletionInput(
          binding.completion,
          file,
          destination,
          provider
        );
        const completionResult = await client.call(binding.completion.operation, completionInput, {
          ...callOptions.complete,
          signal: scope.signal,
        });
        scope.throwIfAborted();
        if (!completionResult.ok) {
          const result = {
            ok: false,
            stage: 'complete',
            result: completionResult,
          } as OperationSignedUploadResult<TContract, TSignId, TCompleteId>;
          if (execution === generation) {
            state.set({ status: 'failure', progress: 1, result });
          }
          return result;
        }
        if (completionResult.notModified === true) {
          throw new ProtocolError('A signed upload completion cannot use a cached 304 result', {
            reason: 'unexpected-status',
            status: 304,
            metadata: completionResult.headers,
          });
        }
        completion = completionResult as OperationSuccessOf<TContract, TCompleteId>;
      }

      const result = { ok: true, provider, completion } as OperationSignedUploadResult<
        TContract,
        TSignId,
        TCompleteId
      >;
      if (execution === generation) state.set({ status: 'complete', progress: 1, result });
      return result;
    } catch (caught: unknown) {
      const error = normalizeSignedUploadError(caught, scope.abortError());
      if (execution === generation) {
        state.set({
          status: error instanceof OperationAbortedError ? 'aborted' : 'error',
          progress: state().progress,
          error,
        });
      }
      throw error;
    } finally {
      scope.cleanup();
      if (execution === generation) {
        activeController = undefined;
        activeXhr = undefined;
      }
    }
  };

  return {
    status: computed(() => state().status),
    pending: computed(() => ['signing', 'uploading', 'completing'].includes(state().status)),
    progress: computed(() => state().progress),
    result: computed(() => state().result),
    error: computed(() => state().error),
    start,
    cancel: () => {
      if (activeController === undefined) return false;
      activeController.abort();
      activeXhr?.abort();
      return true;
    },
    reset: () => {
      activeController?.abort();
      activeXhr?.abort();
      activeController = undefined;
      activeXhr = undefined;
      generation += 1;
      state.set({ status: 'idle', progress: 0 });
    },
    destroy: () => {
      activeController?.abort();
      activeXhr?.abort();
      activeController = undefined;
      activeXhr = undefined;
      generation += 1;
      state.set({
        status: 'aborted',
        progress: state().progress,
        error: new OperationAbortedError(),
      });
    },
  };
}

function serializeSignInput<
  TContract extends object,
  TSignId extends HttpOperationId<TContract>,
  TCompleteId extends HttpOperationId<TContract> | never,
>(
  binding: OperationSignedUploadBinding<TContract, TSignId, TCompleteId>,
  file: File
): InputOf<TContract, TSignId> {
  try {
    return binding.sign.input(file);
  } catch {
    throw new ProtocolError('The generated signed-upload input serializer failed', {
      reason: 'invalid-envelope',
    });
  }
}

function resolveDestination<
  TContract extends object,
  TSignId extends HttpOperationId<TContract>,
  TCompleteId extends HttpOperationId<TContract> | never,
>(
  binding: OperationSignedUploadBinding<TContract, TSignId, TCompleteId>,
  data: OperationDataOf<TContract, TSignId>,
  file: File
): SignedUploadDestination {
  try {
    return binding.sign.destination(data, file);
  } catch {
    throw new ProtocolError('The signed-upload response did not produce a valid destination', {
      reason: 'invalid-envelope',
    });
  }
}

function serializeCompletionInput<
  TContract extends object,
  TCompleteId extends HttpOperationId<TContract>,
>(
  completion: OperationSignedUploadCompletion<TContract, TCompleteId>,
  file: File,
  destination: SignedUploadDestination,
  provider: SignedUploadProviderResult
): InputOf<TContract, TCompleteId> {
  try {
    return completion.input({ file, destination, provider });
  } catch {
    throw new ProtocolError('The generated signed-upload completion serializer failed', {
      reason: 'invalid-envelope',
    });
  }
}

function normalizeProviderOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (origins.length === 0) {
    throw new OperationPolicyError(
      'Signed uploads require at least one exact provider origin',
      'target-origin'
    );
  }
  try {
    return new Set(origins.map(origin => new URL(origin).origin));
  } catch {
    throw new OperationPolicyError(
      'Signed upload provider origins must be absolute URLs',
      'target-origin'
    );
  }
}

function assertProviderOrigin(url: string, allowed: ReadonlySet<string>): void {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new OperationPolicyError('Signed upload destination URL is invalid', 'target-origin');
  }
  if (!allowed.has(target.origin)) {
    throw new OperationPolicyError(
      'Signed upload destination origin is not approved',
      'target-origin'
    );
  }
}

function normalizeSignedUploadError(
  error: unknown,
  abortError: OperationAbortedError | OperationTimeoutError | undefined
): Error {
  if (abortError !== undefined) return abortError;
  if (
    error instanceof OperationUploadValidationError ||
    error instanceof SignedUploadProviderError ||
    error instanceof OperationAbortedError ||
    error instanceof OperationPolicyError ||
    error instanceof ProtocolError ||
    error instanceof TransportError
  ) {
    return error;
  }
  return new TransportError('The signed upload flow failed', {
    reason: 'network',
    causeName: errorName(error),
  });
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'UnknownError';
  return typeof error.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
}
