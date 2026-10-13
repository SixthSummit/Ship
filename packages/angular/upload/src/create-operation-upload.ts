import { computed, type Signal, signal } from '@angular/core';
import {
  abortableOperationDelay,
  createOperationCallScope,
  type ErrorCodeOf,
  failureFromResponse,
  type InputOf,
  OperationAbortedError,
  type OperationCallOptions,
  type OperationFailure,
  OperationPolicyError,
  type OperationRequestPolicy,
  type OperationResultOf,
  type OperationRetryTiming,
  type OperationSuccessStatusOf,
  OperationTimeoutError,
  operationRetryDelay,
  ProtocolError,
  type ResponseMetadata,
  responseMetadataFromHeaders,
  shouldRetryOperationResponse,
  TransportError,
  type UploadOperationId,
} from '@sixthsummit/ship-angular/operations';
import { executeXhrUpload } from './execute-xhr-upload';
import {
  OperationUploadValidationError,
  type OperationUploadValidationIssue,
} from './operation-upload-validation-error';

export interface OperationUploadFile {
  readonly field: string;
  readonly file: File;
}

export interface OperationUploadRequest {
  readonly url: string;
  readonly method?: 'POST' | 'PUT' | 'PATCH';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: FormData;
  /** File/field inventory emitted by the generated serializer for advisory validation. */
  readonly files: readonly OperationUploadFile[];
}

export interface OperationUploadFieldConstraint {
  readonly field: string;
  readonly minimumCount?: number;
  readonly maximumCount?: number;
  readonly maximumBytes?: number;
  readonly acceptedMediaTypes?: readonly string[];
}

export interface OperationUploadResponse {
  readonly status: number;
  readonly statusText: string;
  readonly bodyText: string;
  readonly headers: ResponseMetadata;
}

export interface OperationUploadBinding<
  TContract extends object,
  TId extends UploadOperationId<TContract>,
> {
  readonly request: (input: InputOf<TContract, TId>) => OperationUploadRequest;
  readonly successStatuses: readonly OperationSuccessStatusOf<TContract, TId>[];
  readonly declaredErrors: readonly ErrorCodeOf<TContract, TId>[];
  readonly fields: readonly OperationUploadFieldConstraint[];
  /** Generated decoder validates the status-specific response body. */
  readonly decodeSuccess: (
    response: OperationUploadResponse
  ) =>
    | Extract<
        OperationResultOf<TContract, TId>,
        { readonly ok: true; readonly data: unknown }
      >['data']
    | Promise<
        Extract<
          OperationResultOf<TContract, TId>,
          { readonly ok: true; readonly data: unknown }
        >['data']
      >;
}

export type OperationUploadStatus =
  | 'idle'
  | 'uploading'
  | 'complete'
  | 'failure'
  | 'error'
  | 'aborted';

export interface CreateOperationUploadOptions {
  readonly createXhr?: () => XMLHttpRequest;
  readonly signal?: AbortSignal;
  readonly retry?: OperationRetryTiming;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface OperationUpload<
  TContract extends object,
  TId extends UploadOperationId<TContract>,
> {
  readonly status: Signal<OperationUploadStatus>;
  readonly pending: Signal<boolean>;
  readonly progress: Signal<number>;
  readonly result: Signal<OperationResultOf<TContract, TId> | undefined>;
  readonly failure: Signal<OperationFailure<ErrorCodeOf<TContract, TId>> | undefined>;
  readonly error: Signal<Error | undefined>;
  start(
    input: InputOf<TContract, TId>,
    callOptions?: OperationCallOptions
  ): Promise<OperationResultOf<TContract, TId>>;
  cancel(): boolean;
  reset(): void;
  destroy(): void;
}

interface UploadState<TContract extends object, TId extends UploadOperationId<TContract>> {
  readonly status: OperationUploadStatus;
  readonly progress: number;
  readonly result?: OperationResultOf<TContract, TId>;
  readonly error?: Error;
}

/** Create a progress-aware, stale-safe multipart upload over the shared operation policy. */
export function createOperationUpload<
  TContract extends object,
  TId extends UploadOperationId<TContract>,
>(
  policy: OperationRequestPolicy<TContract>,
  operation: TId,
  binding: OperationUploadBinding<TContract, TId>,
  options: CreateOperationUploadOptions = {}
): OperationUpload<TContract, TId> {
  const state = signal<UploadState<TContract, TId>>({ status: 'idle', progress: 0 });
  let activeController: AbortController | undefined;
  let activeXhr: XMLHttpRequest | undefined;
  let generation = 0;

  const start = async (
    input: InputOf<TContract, TId>,
    callOptions: OperationCallOptions = {}
  ): Promise<OperationResultOf<TContract, TId>> => {
    activeController?.abort();
    activeXhr?.abort();
    const controller = new AbortController();
    activeController = controller;
    generation += 1;
    const execution = generation;
    state.set({ status: 'uploading', progress: 0 });
    let scope: ReturnType<typeof createOperationCallScope> | undefined;
    try {
      const request = serializeUploadRequest(binding, input);
      validateUploadFiles(request.files, binding.fields);
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
        const raw = await executeXhrUpload(
          {
            url: request.url,
            method: request.method ?? 'POST',
            body: request.body,
            headers: { ...(request.headers ?? {}), ...(prepared.headers ?? {}) },
            withCredentials: prepared.credentials === 'include',
          },
          {
            signal: scope.signal,
            ...(options.createXhr === undefined ? {} : { createXhr: options.createXhr }),
            onCreated: xhr => {
              if (execution === generation) activeXhr = xhr;
            },
            onProgress: value => {
              if (execution !== generation) return;
              const current = state();
              state.set({ ...current, progress: Math.max(current.progress, value) });
            },
          }
        );
        scope.throwIfAborted();
        const metadata = responseMetadataFromHeaders(raw.headers);
        if (raw.status < 200 || raw.status >= 300) {
          const failure = await failureFromResponse(
            new Response(raw.bodyText, { status: raw.status, headers: raw.headers }),
            binding.declaredErrors
          );
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
          if (execution === generation) {
            state.set({
              status: 'failure',
              progress: state().progress,
              result: failure as OperationResultOf<TContract, TId>,
            });
          }
          return failure as OperationResultOf<TContract, TId>;
        }
        if (
          !binding.successStatuses.includes(raw.status as OperationSuccessStatusOf<TContract, TId>)
        ) {
          throw new ProtocolError('Upload returned an undeclared success status', {
            reason: 'unexpected-status',
            status: raw.status,
            metadata,
          });
        }
        let data: Awaited<ReturnType<typeof binding.decodeSuccess>>;
        try {
          data = await binding.decodeSuccess({
            status: raw.status,
            statusText: raw.statusText,
            bodyText: raw.bodyText,
            headers: metadata,
          });
        } catch {
          throw new ProtocolError('Upload success response failed contract decoding', {
            reason: 'invalid-envelope',
            status: raw.status,
            metadata,
          });
        }
        const result = {
          ok: true,
          status: raw.status,
          data,
          headers: metadata,
        } as OperationResultOf<TContract, TId>;
        if (execution === generation) {
          state.set({ status: 'complete', progress: 1, result });
        }
        return result;
      }
    } catch (caught: unknown) {
      const error = normalizeUploadError(caught, scope?.abortError());
      if (execution === generation) {
        state.set({
          status: error instanceof OperationAbortedError ? 'aborted' : 'error',
          progress: state().progress,
          error,
        });
      }
      throw error;
    } finally {
      scope?.cleanup();
      if (execution === generation) {
        activeController = undefined;
        activeXhr = undefined;
      }
    }
  };

  const result = computed(() => state().result);
  return {
    status: computed(() => state().status),
    pending: computed(() => state().status === 'uploading'),
    progress: computed(() => state().progress),
    result,
    failure: computed(() => {
      const current = result();
      return current !== undefined && !current.ok
        ? (current as OperationFailure<ErrorCodeOf<TContract, TId>>)
        : undefined;
    }),
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

function serializeUploadRequest<TContract extends object, TId extends UploadOperationId<TContract>>(
  binding: OperationUploadBinding<TContract, TId>,
  input: InputOf<TContract, TId>
): OperationUploadRequest {
  try {
    return binding.request(input);
  } catch {
    throw new ProtocolError('The generated upload request serializer failed', {
      reason: 'invalid-envelope',
    });
  }
}

export function validateUploadFiles(
  files: readonly OperationUploadFile[],
  constraints: readonly OperationUploadFieldConstraint[]
): void {
  const issues: OperationUploadValidationIssue[] = [];
  for (const constraint of constraints) {
    const selected = files.filter(candidate => candidate.field === constraint.field);
    const minimum = constraint.minimumCount ?? 0;
    const maximum = constraint.maximumCount ?? Number.POSITIVE_INFINITY;
    if (selected.length < minimum || selected.length > maximum) {
      issues.push({
        reason: 'invalid-file-count',
        field: constraint.field,
        minimum,
        maximum,
        actual: selected.length,
      });
    }
    for (const candidate of selected) {
      if (constraint.maximumBytes !== undefined && candidate.file.size > constraint.maximumBytes) {
        issues.push({
          reason: 'file-too-large',
          field: constraint.field,
          maximumBytes: constraint.maximumBytes,
          actualBytes: candidate.file.size,
        });
      }
      if (
        constraint.acceptedMediaTypes !== undefined &&
        constraint.acceptedMediaTypes.length > 0 &&
        !matchesMediaType(candidate.file.type, constraint.acceptedMediaTypes)
      ) {
        issues.push({
          reason: 'unsupported-media-type',
          field: constraint.field,
          acceptedMediaTypes: Object.freeze([...constraint.acceptedMediaTypes]),
          actualMediaType: candidate.file.type,
        });
      }
    }
  }
  if (issues.length > 0) throw new OperationUploadValidationError(issues);
}

function matchesMediaType(actual: string, accepted: readonly string[]): boolean {
  const normalized = actual.toLowerCase();
  return accepted.some(candidate => {
    const expected = candidate.toLowerCase();
    return (
      expected === normalized ||
      (expected.endsWith('/*') && normalized.startsWith(expected.slice(0, -1)))
    );
  });
}

function normalizeUploadError(
  error: unknown,
  abortError: OperationAbortedError | OperationTimeoutError | undefined
): Error {
  if (abortError !== undefined) return abortError;
  if (
    error instanceof OperationUploadValidationError ||
    error instanceof OperationAbortedError ||
    error instanceof ProtocolError ||
    error instanceof TransportError ||
    error instanceof OperationPolicyError
  ) {
    return error;
  }
  return new TransportError('The upload transport failed', {
    reason: 'network',
    causeName: errorName(error),
  });
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'UnknownError';
  return typeof error.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
}
