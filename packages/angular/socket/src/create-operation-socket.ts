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
  ProtocolError,
  type SocketOperationId,
  TransportError,
} from '@sixthsummit/ship-angular/operations';

export interface OperationSocketConnection {
  readonly url: string;
  readonly protocols: readonly string[];
}

export interface OperationSocketTicket<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TSocketId extends SocketOperationId<TContract>,
> {
  readonly operation: TId;
  readonly input: (socketInput: InputOf<TContract, TSocketId>) => InputOf<TContract, TId>;
}

export interface OperationSocketReconnectPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface OperationSocketBinding<
  TContract extends object,
  TSocketId extends SocketOperationId<TContract>,
  TClientMessage,
  TTicketId extends HttpOperationId<TContract> | never = never,
> {
  readonly ticket?: [TTicketId] extends [never]
    ? never
    : OperationSocketTicket<TContract, TTicketId, TSocketId>;
  readonly connection: (
    input: InputOf<TContract, TSocketId>,
    ticket: [TTicketId] extends [never] ? undefined : OperationDataOf<TContract, TTicketId>
  ) => OperationSocketConnection;
  readonly decode: (event: MessageEvent) => OperationDataOf<TContract, TSocketId>;
  readonly encode: (message: TClientMessage) => string | ArrayBuffer | Blob | ArrayBufferView;
  readonly cleanCloseCodes: readonly number[];
  readonly reconnectCloseCodes: readonly number[];
  readonly reconnect?: OperationSocketReconnectPolicy;
  readonly requireProtocol?: boolean;
  /** Browser close code: 1000 or 3000–4999; default 4002. */
  readonly protocolErrorCloseCode?: number;
}

export type OperationSocketStatus =
  | 'idle'
  | 'ticketing'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closing'
  | 'closed'
  | 'failure'
  | 'error';

export interface OperationSocketCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type OperationSocketConnectResult<
  TContract extends object,
  TTicketId extends HttpOperationId<TContract> | never,
> =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: 'runtime'; readonly reason: 'unavailable' }
  | ([TTicketId] extends [never]
      ? never
      : {
          readonly ok: false;
          readonly stage: 'ticket';
          readonly result: OperationFailureOf<TContract, TTicketId>;
        });

export type OperationSocketSendResult =
  | { readonly ok: true; readonly queued: boolean }
  | { readonly ok: false; readonly reason: 'not-open' | 'queue-full' | 'encode-failed' };

export interface OperationSocketConnectOptions {
  readonly ticket?: OperationCallOptions;
}

export interface CreateOperationSocketOptions {
  readonly allowedSocketOrigins: readonly string[];
  readonly createWebSocket?: (url: string, protocols: readonly string[]) => WebSocket | undefined;
  readonly signal?: AbortSignal;
  readonly maxMessages?: number;
  readonly maxQueuedSends?: number;
  readonly sendWhileConnecting?: 'queue' | 'reject';
  /** Schedule reconnect work and return its cancellation callback. */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

export interface OperationSocket<
  TContract extends object,
  TSocketId extends SocketOperationId<TContract>,
  TClientMessage,
  TTicketId extends HttpOperationId<TContract> | never = never,
> {
  readonly status: Signal<OperationSocketStatus>;
  readonly messages: Signal<readonly OperationDataOf<TContract, TSocketId>[]>;
  readonly droppedMessages: Signal<number>;
  readonly queuedSends: Signal<number>;
  readonly closeInfo: Signal<OperationSocketCloseInfo | undefined>;
  readonly ticketFailure: Signal<OperationFailureOf<TContract, TTicketId> | undefined>;
  readonly error: Signal<Error | undefined>;
  connect(
    input: InputOf<TContract, TSocketId>,
    options?: OperationSocketConnectOptions
  ): Promise<OperationSocketConnectResult<TContract, TTicketId>>;
  reconnect(): Promise<OperationSocketConnectResult<TContract, TTicketId>> | false;
  send(message: TClientMessage): OperationSocketSendResult;
  close(code?: number, reason?: string): void;
  reset(): void;
  destroy(): void;
}

interface SocketState<TServer, TTicketFailure> {
  readonly status: OperationSocketStatus;
  readonly messages: readonly TServer[];
  readonly droppedMessages: number;
  readonly queuedSends: number;
  readonly closeInfo?: OperationSocketCloseInfo | undefined;
  readonly ticketFailure?: TTicketFailure | undefined;
  readonly error?: Error | undefined;
}

/** Create an explicit, bounded, contract-decoded WebSocket capability. */
export function createOperationSocket<
  TContract extends object,
  TSocketId extends SocketOperationId<TContract>,
  TClientMessage,
  TTicketId extends HttpOperationId<TContract> | never = never,
>(
  client: OperationClient<TContract>,
  binding: OperationSocketBinding<TContract, TSocketId, TClientMessage, TTicketId>,
  options: CreateOperationSocketOptions
): OperationSocket<TContract, TSocketId, TClientMessage, TTicketId> {
  const protocolErrorCloseCode = binding.protocolErrorCloseCode ?? 4002;
  validateCloseCode(protocolErrorCloseCode);
  const allowedOrigins = normalizeSocketOrigins(options.allowedSocketOrigins);
  const maxMessages = positiveInteger(options.maxMessages ?? 1_000, 'maxMessages');
  const maxQueuedSends = positiveInteger(options.maxQueuedSends ?? 100, 'maxQueuedSends');
  validateReconnect(binding.reconnect);
  type ServerMessage = OperationDataOf<TContract, TSocketId>;
  type TicketFailure = OperationFailureOf<TContract, TTicketId>;
  const state = signal<SocketState<ServerMessage, TicketFailure>>({
    status: 'idle',
    messages: [],
    droppedMessages: 0,
    queuedSends: 0,
  });
  let socket: WebSocket | undefined;
  let controller: AbortController | undefined;
  let cancelReconnectTimer: (() => void) | undefined;
  let reconnectAttempts = 0;
  let manualClose = false;
  let generation = 0;
  let queued: Array<string | ArrayBuffer | Blob | ArrayBufferView> = [];
  let cleanupExternalAbort: (() => void) | undefined;
  let lastInvocation:
    | {
        readonly input: InputOf<TContract, TSocketId>;
        readonly options: OperationSocketConnectOptions;
      }
    | undefined;

  const cancelReconnect = () => {
    cancelReconnectTimer?.();
    cancelReconnectTimer = undefined;
  };

  const connectInternal = async (
    input: InputOf<TContract, TSocketId>,
    connectOptions: OperationSocketConnectOptions,
    execution: number,
    reconnecting: boolean
  ): Promise<OperationSocketConnectResult<TContract, TTicketId>> => {
    const activeController = controller;
    if (activeController === undefined || activeController.signal.aborted) {
      throw new OperationAbortedError();
    }
    let ticketData: OperationDataOf<TContract, TTicketId> | undefined;
    const ticket = binding.ticket;
    if (ticket !== undefined) {
      if (execution === generation) {
        state.set({ ...state(), status: reconnecting ? 'reconnecting' : 'ticketing' });
      }
      const ticketInput = serializeTicketInput(ticket, input);
      const ticketScope = createOperationCallScope([
        activeController.signal,
        connectOptions.ticket?.signal,
      ]);
      const ticketResult = await (async () => {
        try {
          ticketScope.throwIfAborted();
          const result = await client.call(ticket.operation, ticketInput, {
            ...connectOptions.ticket,
            signal: ticketScope.signal,
          });
          ticketScope.throwIfAborted();
          return result;
        } catch (error: unknown) {
          ticketScope.throwIfAborted();
          throw error;
        } finally {
          ticketScope.cleanup();
        }
      })();
      if (!ticketResult.ok) {
        const failure = ticketResult as TicketFailure;
        if (execution === generation) {
          state.set({ ...state(), status: 'failure', ticketFailure: failure });
          cleanupExternalAbort?.();
          cleanupExternalAbort = undefined;
        }
        return {
          ok: false,
          stage: 'ticket',
          result: failure,
        } as OperationSocketConnectResult<TContract, TTicketId>;
      }
      if (ticketResult.notModified === true) {
        throw new ProtocolError('A socket ticket cannot use a cached 304 result', {
          reason: 'unexpected-status',
          status: 304,
          metadata: ticketResult.headers,
        });
      }
      ticketData = ticketResult.data as OperationDataOf<TContract, TTicketId>;
    }
    const connection = resolveSocketConnection(binding, input, ticketData);
    validateSocketConnection(connection, allowedOrigins);
    const created = createWebSocket(connection, options.createWebSocket);
    if (created === undefined) {
      if (execution === generation) {
        state.set({ ...state(), status: 'idle' });
        cleanupExternalAbort?.();
        cleanupExternalAbort = undefined;
      }
      return { ok: false, stage: 'runtime', reason: 'unavailable' };
    }
    if (execution !== generation || activeController.signal.aborted) {
      created.close(1000, 'superseded');
      throw new OperationAbortedError();
    }
    socket = created;
    state.set({
      ...state(),
      status: reconnecting ? 'reconnecting' : 'connecting',
      error: undefined,
      ticketFailure: undefined,
      closeInfo: undefined,
    });
    bindSocket(created, connection, input, connectOptions, execution);
    return { ok: true };
  };

  const scheduleReconnect = (
    input: InputOf<TContract, TSocketId>,
    connectOptions: OperationSocketConnectOptions,
    execution: number
  ) => {
    const reconnect = binding.reconnect;
    if (
      reconnect === undefined ||
      manualClose ||
      reconnectAttempts >= reconnect.maxAttempts ||
      execution !== generation
    ) {
      if (execution === generation) {
        state.set({ ...state(), status: 'closed' });
        cleanupExternalAbort?.();
        cleanupExternalAbort = undefined;
      }
      return;
    }
    reconnectAttempts += 1;
    state.set({ ...state(), status: 'reconnecting' });
    const delay = Math.min(
      reconnect.maxDelayMs ?? 30_000,
      (reconnect.baseDelayMs ?? 500) * 2 ** (reconnectAttempts - 1)
    );
    cancelReconnectTimer = (options.schedule ?? scheduleWithTimeout)(() => {
      cancelReconnectTimer = undefined;
      void connectInternal(input, connectOptions, execution, true).catch(caught => {
        const error = normalizeSocketError(caught);
        if (execution !== generation) return;
        if (error instanceof TransportError) {
          state.set({ ...state(), error });
          scheduleReconnect(input, connectOptions, execution);
        } else {
          state.set({ ...state(), status: 'error', error });
          cleanupExternalAbort?.();
          cleanupExternalAbort = undefined;
        }
      });
    }, delay);
  };

  const bindSocket = (
    current: WebSocket,
    connection: OperationSocketConnection,
    input: InputOf<TContract, TSocketId>,
    connectOptions: OperationSocketConnectOptions,
    execution: number
  ) => {
    current.onopen = () => {
      if (execution !== generation || current !== socket) return;
      if (
        binding.requireProtocol === true &&
        (current.protocol.length === 0 || !connection.protocols.includes(current.protocol))
      ) {
        const error = new ProtocolError('Socket did not negotiate a declared subprotocol', {
          reason: 'invalid-message',
        });
        state.set({ ...state(), status: 'error', error });
        manualClose = true;
        current.close(protocolErrorCloseCode, 'protocol error');
        return;
      }
      reconnectAttempts = 0;
      state.set({ ...state(), status: 'open', error: undefined });
      const pending = queued;
      queued = [];
      state.set({ ...state(), queuedSends: 0 });
      for (const payload of pending) current.send(payload as string);
    };
    current.onmessage = event => {
      if (execution !== generation || current !== socket || manualClose) return;
      let decoded: ServerMessage;
      try {
        decoded = binding.decode(event);
      } catch {
        const error = new ProtocolError('Socket message failed contract decoding', {
          reason: 'invalid-message',
        });
        state.set({ ...state(), status: 'error', error });
        manualClose = true;
        current.close(protocolErrorCloseCode, 'invalid message');
        return;
      }
      const appended = [...state().messages, decoded];
      const overflow = Math.max(0, appended.length - maxMessages);
      state.set({
        ...state(),
        messages: overflow === 0 ? appended : appended.slice(overflow),
        droppedMessages: state().droppedMessages + overflow,
      });
    };
    current.onerror = () => {
      if (execution !== generation || current !== socket) return;
      state.set({
        ...state(),
        error: new TransportError('The socket transport reported an error', {
          reason: 'connection',
        }),
      });
    };
    current.onclose = event => {
      if (execution !== generation || current !== socket) return;
      socket = undefined;
      const closeInfo: OperationSocketCloseInfo = {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      };
      state.set({ ...state(), closeInfo });
      if (manualClose || binding.cleanCloseCodes.includes(event.code)) {
        state.set({ ...state(), status: 'closed', closeInfo });
        cleanupExternalAbort?.();
        cleanupExternalAbort = undefined;
        return;
      }
      if (binding.reconnectCloseCodes.includes(event.code)) {
        scheduleReconnect(input, connectOptions, execution);
        return;
      }
      state.set({ ...state(), status: 'closed', closeInfo });
      cleanupExternalAbort?.();
      cleanupExternalAbort = undefined;
    };
  };

  const connect = async (
    input: InputOf<TContract, TSocketId>,
    connectOptions: OperationSocketConnectOptions = {}
  ): Promise<OperationSocketConnectResult<TContract, TTicketId>> => {
    cancelReconnect();
    cleanupExternalAbort?.();
    cleanupExternalAbort = undefined;
    controller?.abort();
    if (socket !== undefined) {
      manualClose = true;
      socket.close(1000, 'superseded');
    }
    generation += 1;
    const execution = generation;
    manualClose = false;
    reconnectAttempts = 0;
    queued = [];
    const nextController = new AbortController();
    controller = nextController;
    const onExternalAbort = () => {
      nextController.abort();
      if (execution !== generation) return;
      manualClose = true;
      socket?.close(1000, 'aborted');
      state.set({ ...state(), status: 'closed', error: new OperationAbortedError() });
    };
    if (options.signal?.aborted) onExternalAbort();
    else if (options.signal !== undefined) {
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
      cleanupExternalAbort = () => options.signal?.removeEventListener('abort', onExternalAbort);
    }
    lastInvocation = { input, options: connectOptions };
    state.set({
      status: 'connecting',
      messages: [],
      droppedMessages: 0,
      queuedSends: queued.length,
    });
    try {
      return await connectInternal(input, connectOptions, execution, false);
    } catch (caught: unknown) {
      const error = normalizeSocketError(caught);
      if (execution === generation) {
        state.set({
          ...state(),
          status: error instanceof OperationAbortedError ? 'closed' : 'error',
          error,
        });
        cleanupExternalAbort?.();
        cleanupExternalAbort = undefined;
      }
      throw error;
    }
  };

  return {
    status: computed(() => state().status),
    messages: computed(() => state().messages),
    droppedMessages: computed(() => state().droppedMessages),
    queuedSends: computed(() => state().queuedSends),
    closeInfo: computed(() => state().closeInfo),
    ticketFailure: computed(() => state().ticketFailure),
    error: computed(() => state().error),
    connect,
    reconnect: () => {
      if (
        lastInvocation === undefined ||
        ['open', 'connecting', 'ticketing'].includes(state().status)
      ) {
        return false;
      }
      return connect(lastInvocation.input, lastInvocation.options);
    },
    send: message => {
      const open = state().status === 'open' && socket !== undefined && socket.readyState === 1;
      const queueable =
        options.sendWhileConnecting === 'queue' &&
        ['ticketing', 'connecting', 'reconnecting'].includes(state().status);
      if (!open && !queueable) return { ok: false, reason: 'not-open' };
      let payload: string | ArrayBuffer | Blob | ArrayBufferView;
      try {
        payload = binding.encode(message);
      } catch {
        const error = new ProtocolError('Socket outgoing message failed contract encoding', {
          reason: 'invalid-message',
        });
        state.set({ ...state(), error });
        return { ok: false, reason: 'encode-failed' };
      }
      if (open && socket !== undefined) {
        socket.send(payload as string);
        return { ok: true, queued: false };
      }
      if (queued.length >= maxQueuedSends) return { ok: false, reason: 'queue-full' };
      queued.push(payload);
      state.set({ ...state(), queuedSends: queued.length });
      return { ok: true, queued: true };
    },
    close: (code, reason) => {
      if (code !== undefined) validateCloseCode(code);
      if (reason !== undefined && new TextEncoder().encode(reason).byteLength > 123) {
        throw new RangeError('Socket close reason must be at most 123 UTF-8 bytes');
      }
      cancelReconnect();
      cleanupExternalAbort?.();
      cleanupExternalAbort = undefined;
      manualClose = true;
      controller?.abort();
      queued = [];
      if (socket === undefined) {
        state.set({ ...state(), status: 'closed', queuedSends: 0 });
        return;
      }
      state.set({ ...state(), status: 'closing', queuedSends: 0 });
      try {
        socket.close(code, reason);
      } catch {
        socket = undefined;
        state.set({ ...state(), status: 'closed' });
      }
    },
    reset: () => {
      cancelReconnect();
      cleanupExternalAbort?.();
      cleanupExternalAbort = undefined;
      manualClose = true;
      controller?.abort();
      socket?.close(1000, 'reset');
      socket = undefined;
      controller = undefined;
      queued = [];
      lastInvocation = undefined;
      generation += 1;
      state.set({ status: 'idle', messages: [], droppedMessages: 0, queuedSends: 0 });
    },
    destroy: () => {
      cancelReconnect();
      cleanupExternalAbort?.();
      cleanupExternalAbort = undefined;
      manualClose = true;
      controller?.abort();
      socket?.close(1000, 'destroy');
      socket = undefined;
      controller = undefined;
      queued = [];
      lastInvocation = undefined;
      generation += 1;
      state.set({
        status: 'closed',
        messages: state().messages,
        droppedMessages: state().droppedMessages,
        queuedSends: 0,
      });
    },
  };
}

function serializeTicketInput<
  TContract extends object,
  TTicketId extends HttpOperationId<TContract>,
  TSocketId extends SocketOperationId<TContract>,
>(
  ticket: OperationSocketTicket<TContract, TTicketId, TSocketId>,
  input: InputOf<TContract, TSocketId>
): InputOf<TContract, TTicketId> {
  try {
    return ticket.input(input);
  } catch {
    throw new ProtocolError('Socket ticket input failed contract serialization', {
      reason: 'invalid-envelope',
    });
  }
}

function resolveSocketConnection<
  TContract extends object,
  TSocketId extends SocketOperationId<TContract>,
  TClientMessage,
  TTicketId extends HttpOperationId<TContract> | never,
>(
  binding: OperationSocketBinding<TContract, TSocketId, TClientMessage, TTicketId>,
  input: InputOf<TContract, TSocketId>,
  ticket: OperationDataOf<TContract, TTicketId> | undefined
): OperationSocketConnection {
  try {
    return binding.connection(
      input,
      ticket as [TTicketId] extends [never] ? undefined : OperationDataOf<TContract, TTicketId>
    );
  } catch {
    throw new ProtocolError('Socket connection metadata failed contract decoding', {
      reason: 'invalid-envelope',
    });
  }
}

function normalizeSocketOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (origins.length === 0) throw new RangeError('Socket requires an allowed origin');
  try {
    return new Set(
      origins.map(origin => {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error();
        return parsed.origin;
      })
    );
  } catch {
    throw new RangeError('Socket origins must be absolute ws:// or wss:// URLs');
  }
}

function validateSocketConnection(
  connection: OperationSocketConnection,
  allowedOrigins: ReadonlySet<string>
): void {
  let parsed: URL;
  try {
    parsed = new URL(connection.url);
  } catch {
    throw new ProtocolError('Socket URL is not absolute', { reason: 'invalid-envelope' });
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new ProtocolError('Socket URL origin is not allowed', { reason: 'invalid-envelope' });
  }
  for (const name of parsed.searchParams.keys()) {
    if (/^(authorization|bearer|token|access_token|id_token)$/i.test(name)) {
      throw new ProtocolError('Bearer credentials cannot be placed in socket query parameters', {
        reason: 'invalid-envelope',
      });
    }
  }
  if (new Set(connection.protocols).size !== connection.protocols.length) {
    throw new ProtocolError('Socket subprotocols must be unique', { reason: 'invalid-envelope' });
  }
}

function createWebSocket(
  connection: OperationSocketConnection,
  factory: CreateOperationSocketOptions['createWebSocket']
): WebSocket | undefined {
  try {
    if (factory !== undefined) return factory(connection.url, connection.protocols);
    if (typeof WebSocket === 'undefined') return undefined;
    return new WebSocket(connection.url, [...connection.protocols]);
  } catch (error: unknown) {
    throw new TransportError('The socket connection could not be created', {
      reason: 'connection',
      causeName: errorName(error),
    });
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function scheduleWithTimeout(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

function validateReconnect(reconnect: OperationSocketReconnectPolicy | undefined): void {
  if (reconnect === undefined) return;
  if (!Number.isInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 0) {
    throw new RangeError('Socket reconnect maxAttempts must be a non-negative integer');
  }
}

function normalizeSocketError(error: unknown): Error {
  if (
    error instanceof OperationAbortedError ||
    error instanceof ProtocolError ||
    error instanceof TransportError
  ) {
    return error;
  }
  return new TransportError('The socket transport failed', {
    reason: 'connection',
    causeName: errorName(error),
  });
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'UnknownError';
  return typeof error.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
}

function validateCloseCode(code: number): void {
  if (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999))) {
    throw new RangeError('Socket close code must be 1000 or an integer from 3000 to 4999');
  }
}
