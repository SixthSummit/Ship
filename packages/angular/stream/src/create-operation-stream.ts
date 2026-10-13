import { computed, type Signal, signal } from '@angular/core';
import {
  abortableOperationDelay,
  createOperationCallScope,
  type ErrorCodeOf,
  failureFromResponse,
  type InputOf,
  OperationAbortedError,
  type OperationCallOptions,
  type OperationDataOf,
  type OperationFailure,
  type OperationIdempotency,
  OperationPolicyError,
  type OperationRequestPolicy,
  type OperationRetryTiming,
  type OperationSafety,
  type OperationSuccessStatusOf,
  OperationTimeoutError,
  operationRetryDelay,
  ProtocolError,
  type ResponseMetadata,
  responseMetadataFromHeaders,
  type StreamOperationId,
  shouldRetryOperationResponse,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { parseSseFrames, type SseFrame } from './parse-sse-frames';

export interface OperationStreamRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit | null;
}

export type OperationStreamReconnectReason = 'normal' | 'network';

export interface OperationStreamReconnectPolicy extends OperationRetryTiming {
  /** Number of connections after the initial request. */
  readonly maxAttempts: number;
  readonly on: readonly OperationStreamReconnectReason[];
}

export interface OperationStreamBinding<
  TContract extends object,
  TId extends StreamOperationId<TContract>,
> {
  readonly request: (input: InputOf<TContract, TId>) => OperationStreamRequest;
  readonly successStatuses: readonly OperationSuccessStatusOf<TContract, TId>[];
  readonly declaredErrors: readonly ErrorCodeOf<TContract, TId>[];
  readonly contentTypes?: readonly string[];
  readonly decode: (
    frame: SseFrame
  ) =>
    | OperationDataOf<TContract, TId>
    | undefined
    | Promise<OperationDataOf<TContract, TId> | undefined>;
  readonly reconnect?: OperationStreamReconnectPolicy;
  readonly lastEventIdHeader?: string;
}

export type OperationStreamStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'failure'
  | 'error'
  | 'aborted';

export type OperationStreamTerminal<TCode extends string> =
  | {
      readonly kind: 'closed';
      readonly headers: ResponseMetadata;
      readonly lastEventId?: string;
    }
  | {
      readonly kind: 'failure';
      readonly result: OperationFailure<TCode>;
    };

export interface CreateOperationStreamOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  /** Bounded retained history. Oldest events are dropped first. Default: 1000. */
  readonly maxEvents?: number;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface OperationStream<
  TContract extends object,
  TId extends StreamOperationId<TContract>,
> {
  readonly status: Signal<OperationStreamStatus>;
  readonly pending: Signal<boolean>;
  readonly events: Signal<readonly OperationDataOf<TContract, TId>[]>;
  readonly droppedEvents: Signal<number>;
  readonly failure: Signal<OperationFailure<ErrorCodeOf<TContract, TId>> | undefined>;
  readonly error: Signal<Error | undefined>;
  readonly headers: Signal<ResponseMetadata | undefined>;
  readonly lastEventId: Signal<string | undefined>;
  start(
    input: InputOf<TContract, TId>,
    callOptions?: OperationCallOptions
  ): Promise<OperationStreamTerminal<ErrorCodeOf<TContract, TId>>>;
  reload(): Promise<OperationStreamTerminal<ErrorCodeOf<TContract, TId>>> | false;
  cancel(): boolean;
  reset(): void;
  destroy(): void;
}

interface StreamState<TData, TCode extends string> {
  readonly status: OperationStreamStatus;
  readonly events: readonly TData[];
  readonly droppedEvents: number;
  readonly failure?: OperationFailure<TCode> | undefined;
  readonly error?: Error | undefined;
  readonly headers?: ResponseMetadata;
  readonly lastEventId?: string | undefined;
}

/** Open a contract-decoded SSE stream with bounded history and explicit reconnect policy. */
export function createOperationStream<
  TContract extends object,
  TId extends StreamOperationId<TContract>,
>(
  policy: OperationRequestPolicy<TContract>,
  operation: TId,
  binding: OperationStreamBinding<TContract, TId>,
  options: CreateOperationStreamOptions = {}
): OperationStream<TContract, TId> {
  const maxEvents = options.maxEvents ?? 1_000;
  if (!Number.isInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError('Operation stream maxEvents must be a positive integer');
  }
  validateReconnectPolicy(binding.reconnect);
  type Data = OperationDataOf<TContract, TId>;
  type Code = ErrorCodeOf<TContract, TId>;
  const state = signal<StreamState<Data, Code>>({
    status: 'idle',
    events: [],
    droppedEvents: 0,
  });
  let active: AbortController | undefined;
  let generation = 0;
  let lastInvocation:
    | { readonly input: InputOf<TContract, TId>; readonly options: OperationCallOptions }
    | undefined;

  const start = async (
    input: InputOf<TContract, TId>,
    callOptions: OperationCallOptions = {}
  ): Promise<OperationStreamTerminal<Code>> => {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    generation += 1;
    const execution = generation;
    lastInvocation = { input, options: callOptions };
    state.set({ status: 'connecting', events: [], droppedEvents: 0 });
    let scope: ReturnType<typeof createOperationCallScope> | undefined;
    try {
      const request = serializeStreamRequest(binding, input);
      const policyCall = policy.begin(operation, callOptions);
      scope = createOperationCallScope(
        [controller.signal, callOptions.signal, options.signal],
        callOptions.timeoutMs
      );
      scope.throwIfAborted();
      let requestAttempt = 1;
      let statusRetryAttempt = 1;
      let reconnectAttempt = 0;
      let reconnectDelayMs: number | undefined;
      let lastEventId: string | undefined;

      while (true) {
        const prepared = await policyCall.prepare({
          attempt: requestAttempt,
          signal: scope.signal,
          targetUrl: request.url,
        });
        scope.throwIfAborted();
        let response: Response;
        try {
          response = await (options.fetch ?? fetch)(request.url, {
            method: request.method ?? 'GET',
            ...(request.body === undefined ? {} : { body: request.body }),
            headers: {
              accept: 'text/event-stream',
              ...(request.headers ?? {}),
              ...(prepared.headers ?? {}),
              ...(lastEventId === undefined
                ? {}
                : { [binding.lastEventIdHeader ?? 'last-event-id']: lastEventId }),
            },
            ...(prepared.credentials === undefined ? {} : { credentials: prepared.credentials }),
            signal: scope.signal,
            redirect: 'error',
          });
        } catch (caught: unknown) {
          scope.throwIfAborted();
          if (
            canReconnect(
              'network',
              binding.reconnect,
              reconnectAttempt,
              policyCall.executionPolicy.safety,
              policyCall.executionPolicy.replayable,
              policyCall.executionPolicy.idempotency,
              callOptions.idempotencyKey
            )
          ) {
            reconnectAttempt += 1;
            requestAttempt += 1;
            await waitToReconnect(
              binding.reconnect!,
              reconnectDelayMs,
              reconnectAttempt,
              scope.signal,
              options.delay,
              execution,
              generation,
              state
            );
            continue;
          }
          throw normalizeStreamNetworkError(caught);
        }
        scope.throwIfAborted();
        const metadata = responseMetadataFromHeaders(response.headers);
        if (!response.ok) {
          const failure = await failureFromResponse(response, binding.declaredErrors);
          if (
            await policyCall.refreshAuthentication(failure.status, requestAttempt, scope.signal)
          ) {
            requestAttempt += 1;
            continue;
          }
          if (
            shouldRetryOperationResponse(
              failure,
              policyCall.executionPolicy,
              callOptions.idempotencyKey,
              statusRetryAttempt
            )
          ) {
            const delayMs = operationRetryDelay(
              failure.headers.retryAfterMs,
              statusRetryAttempt,
              binding.reconnect
            );
            await (options.delay ?? abortableOperationDelay)(delayMs, scope.signal);
            statusRetryAttempt += 1;
            requestAttempt += 1;
            continue;
          }
          const terminal: OperationStreamTerminal<Code> = { kind: 'failure', result: failure };
          if (execution === generation) {
            state.set({
              status: 'failure',
              events: state().events,
              droppedEvents: state().droppedEvents,
              failure,
              headers: metadata,
              lastEventId,
            });
          }
          return terminal;
        }
        if (
          !binding.successStatuses.includes(
            response.status as OperationSuccessStatusOf<TContract, TId>
          )
        ) {
          throw new ProtocolError('Stream returned an undeclared success status', {
            reason: 'unexpected-status',
            status: response.status,
            metadata,
          });
        }
        if (response.status === 204) {
          return closeStream(metadata, lastEventId, execution, generation, state);
        }
        validateStreamContentType(metadata, binding.contentTypes, response.status);
        if (response.body === null) {
          throw new ProtocolError('Stream response did not include a readable body', {
            reason: 'invalid-envelope',
            status: response.status,
            metadata,
          });
        }
        if (execution === generation) {
          state.set({
            ...state(),
            status: 'open',
            headers: metadata,
            lastEventId,
            failure: undefined,
            error: undefined,
          });
        }

        try {
          for await (const frame of parseSseFrames(response.body, scope.signal)) {
            scope.throwIfAborted();
            lastEventId = frame.id;
            if (frame.retry !== undefined) reconnectDelayMs = frame.retry;
            let decoded: Data | undefined;
            try {
              decoded = await binding.decode(frame);
            } catch {
              throw new ProtocolError('Stream event failed contract decoding', {
                reason: 'invalid-event',
                status: response.status,
                metadata,
              });
            }
            if (execution === generation) {
              if (decoded !== undefined) appendEvent(state, decoded, maxEvents, lastEventId);
              else state.set({ ...state(), lastEventId });
            }
          }
          scope.throwIfAborted();
        } catch (caught: unknown) {
          scope.throwIfAborted();
          if (caught instanceof ProtocolError) throw caught;
          if (
            canReconnect(
              'network',
              binding.reconnect,
              reconnectAttempt,
              policyCall.executionPolicy.safety,
              policyCall.executionPolicy.replayable,
              policyCall.executionPolicy.idempotency,
              callOptions.idempotencyKey
            )
          ) {
            reconnectAttempt += 1;
            requestAttempt += 1;
            await waitToReconnect(
              binding.reconnect!,
              reconnectDelayMs,
              reconnectAttempt,
              scope.signal,
              options.delay,
              execution,
              generation,
              state
            );
            continue;
          }
          throw normalizeStreamNetworkError(caught, metadata);
        }

        if (
          canReconnect(
            'normal',
            binding.reconnect,
            reconnectAttempt,
            policyCall.executionPolicy.safety,
            policyCall.executionPolicy.replayable,
            policyCall.executionPolicy.idempotency,
            callOptions.idempotencyKey
          )
        ) {
          reconnectAttempt += 1;
          requestAttempt += 1;
          await waitToReconnect(
            binding.reconnect!,
            reconnectDelayMs,
            reconnectAttempt,
            scope.signal,
            options.delay,
            execution,
            generation,
            state
          );
          continue;
        }
        return closeStream(metadata, lastEventId, execution, generation, state);
      }
    } catch (caught: unknown) {
      const error = normalizeStreamError(caught, scope?.abortError());
      if (execution === generation) {
        state.set({
          ...state(),
          status: error instanceof OperationAbortedError ? 'aborted' : 'error',
          error,
        });
      }
      throw error;
    } finally {
      scope?.cleanup();
      if (execution === generation) active = undefined;
    }
  };

  return {
    status: computed(() => state().status),
    pending: computed(() => ['connecting', 'open', 'reconnecting'].includes(state().status)),
    events: computed(() => state().events),
    droppedEvents: computed(() => state().droppedEvents),
    failure: computed(() => state().failure),
    error: computed(() => state().error),
    headers: computed(() => state().headers),
    lastEventId: computed(() => state().lastEventId),
    start,
    reload: () =>
      lastInvocation === undefined ? false : start(lastInvocation.input, lastInvocation.options),
    cancel: () => {
      if (active === undefined) return false;
      active.abort();
      return true;
    },
    reset: () => {
      active?.abort();
      active = undefined;
      generation += 1;
      lastInvocation = undefined;
      state.set({ status: 'idle', events: [], droppedEvents: 0 });
    },
    destroy: () => {
      active?.abort();
      active = undefined;
      generation += 1;
      lastInvocation = undefined;
      state.set({
        status: 'aborted',
        events: state().events,
        droppedEvents: state().droppedEvents,
        error: new OperationAbortedError(),
      });
    },
  };
}

function serializeStreamRequest<TContract extends object, TId extends StreamOperationId<TContract>>(
  binding: OperationStreamBinding<TContract, TId>,
  input: InputOf<TContract, TId>
): OperationStreamRequest {
  try {
    return binding.request(input);
  } catch {
    throw new ProtocolError('The generated stream request serializer failed', {
      reason: 'invalid-envelope',
    });
  }
}

function validateReconnectPolicy(policy: OperationStreamReconnectPolicy | undefined): void {
  if (policy === undefined) return;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 0) {
    throw new RangeError('Operation stream reconnect maxAttempts must be a non-negative integer');
  }
}

function validateStreamContentType(
  metadata: ResponseMetadata,
  contentTypes: readonly string[] | undefined,
  status: number
): void {
  const allowed = contentTypes ?? ['text/event-stream'];
  const received = metadata.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (received !== undefined && allowed.some(value => value.toLowerCase() === received)) return;
  throw new ProtocolError('Stream response content type was not declared', {
    reason: 'unexpected-content-type',
    status,
    metadata,
    ...(metadata.contentType === undefined ? {} : { receivedContentType: metadata.contentType }),
  });
}

function canReconnect(
  reason: OperationStreamReconnectReason,
  reconnect: OperationStreamReconnectPolicy | undefined,
  attempts: number,
  safety: OperationSafety,
  replayable: boolean,
  idempotency: OperationIdempotency,
  idempotencyKey: string | undefined
): boolean {
  if (
    reconnect === undefined ||
    !reconnect.on.includes(reason) ||
    attempts >= reconnect.maxAttempts
  ) {
    return false;
  }
  if (safety === 'safe') return true;
  if (safety === 'idempotent') return replayable;
  return replayable && idempotency !== 'unsupported' && Boolean(idempotencyKey);
}

async function waitToReconnect<TData, TCode extends string>(
  reconnect: OperationStreamReconnectPolicy,
  serverDelayMs: number | undefined,
  reconnectAttempt: number,
  signal: AbortSignal,
  delay: ((milliseconds: number, signal: AbortSignal) => Promise<void>) | undefined,
  execution: number,
  generation: number,
  state: { update(updater: (value: StreamState<TData, TCode>) => StreamState<TData, TCode>): void }
): Promise<void> {
  if (execution === generation) state.update(value => ({ ...value, status: 'reconnecting' }));
  const delayMs = operationRetryDelay(serverDelayMs, reconnectAttempt, reconnect);
  await (delay ?? abortableOperationDelay)(delayMs, signal);
}

function appendEvent<TData, TCode extends string>(
  state: {
    (): StreamState<TData, TCode>;
    set(value: StreamState<TData, TCode>): void;
  },
  event: TData,
  maximum: number,
  lastEventId: string | undefined
): void {
  const current = state();
  const appended = [...current.events, event];
  const overflow = Math.max(0, appended.length - maximum);
  state.set({
    ...current,
    events: overflow === 0 ? appended : appended.slice(overflow),
    droppedEvents: current.droppedEvents + overflow,
    lastEventId,
  });
}

function closeStream<TData, TCode extends string>(
  metadata: ResponseMetadata,
  lastEventId: string | undefined,
  execution: number,
  generation: number,
  state: { set(value: StreamState<TData, TCode>): void; (): StreamState<TData, TCode> }
): OperationStreamTerminal<TCode> {
  const terminal: OperationStreamTerminal<TCode> = {
    kind: 'closed',
    headers: metadata,
    ...(lastEventId === undefined ? {} : { lastEventId }),
  };
  if (execution === generation) {
    state.set({
      ...state(),
      status: 'closed',
      headers: metadata,
      lastEventId,
      error: undefined,
      failure: undefined,
    });
  }
  return terminal;
}

function normalizeStreamNetworkError(error: unknown, metadata?: ResponseMetadata): TransportError {
  if (error instanceof TransportError) return error;
  return new TransportError('The stream transport failed', {
    reason: 'network',
    ...(metadata === undefined ? {} : { metadata }),
    causeName: errorName(error),
  });
}

function normalizeStreamError(
  error: unknown,
  abortError: OperationAbortedError | OperationTimeoutError | undefined
): Error {
  if (abortError !== undefined) return abortError;
  if (
    error instanceof OperationAbortedError ||
    error instanceof OperationPolicyError ||
    error instanceof ProtocolError ||
    error instanceof TransportError
  ) {
    return error;
  }
  return normalizeStreamNetworkError(error);
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'UnknownError';
  return typeof error.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
}
