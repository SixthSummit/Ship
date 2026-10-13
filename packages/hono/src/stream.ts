import type {
  OperationFailureResult,
  OperationStreamSink,
  OperationSuccessResult,
} from "@sixthsummit/ship-core";
import { HTTP_STREAM_CONTENT_TYPE, type HttpStreamResponse } from "./transport.js";

/** Wire format version advertised on every stream response. */
export const STREAM_PROTOCOL_HEADER = "sse/1";

export type SseEventName = "frame" | "terminal" | "error";

export interface SseEvent {
  readonly id: number;
  readonly event: SseEventName;
  readonly data: unknown;
}

export interface StreamErrorFrame {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details?: unknown;
}

/** Stable terminal error frames owned by the adapter. */
export const STREAM_ERROR_CODES = Object.freeze({
  maxDuration: Object.freeze({
    code: "STREAM_MAX_DURATION_EXCEEDED",
    status: 504,
    message: "Stream exceeded its maximum duration",
  }),
  maxFrames: Object.freeze({
    code: "STREAM_MAX_FRAMES_EXCEEDED",
    status: 500,
    message: "Stream exceeded its maximum frame count",
  }),
  internal: Object.freeze({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "An unexpected error occurred",
  }),
});

/** Encodes one event as `id`, `event`, then a single JSON `data` line. */
export function encodeSseEvent(event: SseEvent): string {
  const data = JSON.stringify(event.data === undefined ? null : event.data);
  if (data === undefined) throw new TypeError("SSE event data is not JSON serializable");
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${data}\n\n`;
}

/** Encodes the keep-alive comment emitted while a stream is idle. */
export function encodeSseHeartbeat(unixMs: number): string {
  return `: hb ${unixMs}\n\n`;
}

/** Raised into a handler that keeps emitting after the adapter ended the stream. */
export class StreamTerminatedError extends Error {
  readonly code: string;

  constructor(frame: StreamErrorFrame | undefined) {
    super(frame ? frame.message : "Stream is no longer writable");
    this.name = "StreamTerminatedError";
    this.code = frame?.code ?? "STREAM_CLOSED";
  }
}

interface SseChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly closed: boolean;
  readonly busy: boolean;
  write(text: string): Promise<void>;
  close(): Promise<void>;
  onCancel(listener: (reason: unknown) => void): void;
}

/**
 * A byte channel whose writes resolve only once the consumer has pulled the
 * chunk. At most one chunk is ever queued, so a slow reader applies
 * backpressure directly to the emitting handler.
 */
function createSseChannel(): SseChannel {
  const encoder = new TextEncoder();
  const cancelListeners: ((reason: unknown) => void)[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pullPending = false;
  let notifyPull: (() => void) | undefined;
  let resolvePull: (() => void) | undefined;
  let closed = false;
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();

  const readable = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
      },
      pull() {
        pullPending = true;
        notifyPull?.();
        notifyPull = undefined;
        return new Promise<void>((resolve) => {
          resolvePull = resolve;
        });
      },
      cancel(reason) {
        closed = true;
        notifyPull?.();
        notifyPull = undefined;
        for (const listener of cancelListeners) listener(reason);
      },
    },
    { highWaterMark: 0 },
  );

  const writeChunk = async (text: string): Promise<void> => {
    if (closed) throw new StreamTerminatedError(undefined);
    if (!pullPending) {
      await new Promise<void>((resolve) => {
        notifyPull = resolve;
      });
    }
    if (closed) throw new StreamTerminatedError(undefined);
    pullPending = false;
    controller?.enqueue(encoder.encode(text));
    resolvePull?.();
    resolvePull = undefined;
  };

  const enqueue = <TValue>(work: () => Promise<TValue>): Promise<TValue> => {
    pending += 1;
    const next = tail.then(work);
    tail = next.then(
      () => {
        pending -= 1;
      },
      () => {
        pending -= 1;
      },
    );
    return next;
  };

  return {
    readable,
    get closed() {
      return closed;
    },
    get busy() {
      return pending > 0;
    },
    write: (text) => enqueue(() => writeChunk(text)),
    close: () =>
      enqueue(async () => {
        if (closed) return;
        closed = true;
        controller?.close();
        resolvePull?.();
        resolvePull = undefined;
      }),
    onCancel: (listener) => {
      cancelListeners.push(listener);
    },
  };
}

export interface StreamExecutionOptions {
  readonly declaration: HttpStreamResponse;
  readonly requestId: string;
  readonly requestSignal: AbortSignal;
  /** Framework-owned response headers; the stream adds its content type and protocol marker. */
  readonly headers: Headers;
  readonly run: (options: {
    readonly signal: AbortSignal;
    readonly stream: OperationStreamSink;
  }) => Promise<OperationSuccessResult | OperationFailureResult>;
  readonly serializeFailure: (failure: OperationFailureResult) => Response;
  readonly onUnexpectedError: (error: unknown) => Promise<void>;
}

type RunOutcome =
  | { readonly kind: "settled"; readonly result: OperationSuccessResult | OperationFailureResult }
  | { readonly kind: "threw"; readonly error: unknown };

/**
 * Runs a streaming operation. Failures before the first frame use the unary
 * wire contract; after the first frame every outcome becomes a terminal
 * `terminal` or `error` event on a `text/event-stream` response.
 */
export async function executeStreamOperation(options: StreamExecutionOptions): Promise<Response> {
  const { declaration, requestId, requestSignal } = options;
  const heartbeatMs = declaration.heartbeatMs as number;
  const maxDurationMs = declaration.maxDurationMs as number;
  const maxFrames = declaration.maxFrames as number;
  const abort = new AbortController();
  const channel = createSseChannel();
  let sequence = 0;
  let started = false;
  let finished = false;
  let limit: StreamErrorFrame | undefined;
  let lastActivityAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let signalStart: () => void = () => {};
  const startedPromise = new Promise<void>((resolve) => {
    signalStart = resolve;
  });

  const onRequestAbort = () => abort.abort(requestSignal.reason);
  if (requestSignal.aborted) onRequestAbort();
  else requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  channel.onCancel((reason) =>
    abort.abort(reason ?? new StreamTerminatedError({ ...STREAM_ERROR_CODES.internal })),
  );

  const sink: OperationStreamSink = {
    write: async (frame) => {
      if (limit || finished || channel.closed) throw new StreamTerminatedError(limit);
      if (sequence >= maxFrames) {
        limit = STREAM_ERROR_CODES.maxFrames;
        abort.abort(new StreamTerminatedError(limit));
        signalStart();
        void terminate(limit);
        throw new StreamTerminatedError(limit);
      }
      sequence += 1;
      const text = encodeSseEvent({ id: sequence, event: "frame", data: frame });
      started = true;
      signalStart();
      await channel.write(text);
      lastActivityAt = Date.now();
    },
  };

  const cleanup = () => {
    clearTimeout(durationTimer);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    requestSignal.removeEventListener("abort", onRequestAbort);
  };

  const terminate = async (event: StreamErrorFrame | { readonly terminal: unknown }) => {
    if (finished) return;
    finished = true;
    cleanup();
    try {
      if (!channel.closed) {
        const encoded =
          "terminal" in event
            ? encodeSseEvent({ id: sequence + 1, event: "terminal", data: event.terminal })
            : encodeSseEvent({ id: sequence + 1, event: "error", data: event });
        await channel.write(encoded);
      }
    } catch {
      // The consumer went away; closing below releases the channel.
    }
    await channel.close();
  };

  const settled: Promise<RunOutcome> = options.run({ signal: abort.signal, stream: sink }).then(
    (result) => ({ kind: "settled", result }) as const,
    (error) => ({ kind: "threw", error }) as const,
  );
  const durationTimer = setTimeout(() => {
    if (finished) return;
    limit = STREAM_ERROR_CODES.maxDuration;
    abort.abort(new StreamTerminatedError(limit));
    signalStart();
    if (started) void terminate(limit);
  }, maxDurationMs);

  const complete = async () => {
    const outcome = await settled;
    if (finished) return;
    if (limit) return terminate(limit);
    if (channel.closed) {
      finished = true;
      cleanup();
      return;
    }
    if (outcome.kind === "threw") {
      await options.onUnexpectedError(outcome.error);
      return terminate(STREAM_ERROR_CODES.internal);
    }
    if (!outcome.result.ok) {
      const { error } = outcome.result;
      return terminate({
        code: error.code,
        status: outcome.result.status,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
    return terminate({ terminal: outcome.result.data });
  };

  const first = await Promise.race([startedPromise.then(() => "started" as const), settled]);
  if (!started) {
    cleanup();
    if (limit) {
      return options.serializeFailure({
        ok: false,
        status: limit.status,
        error: { code: limit.code, message: limit.message },
        requestId,
      });
    }
    const outcome = first as RunOutcome;
    if (outcome.kind === "threw") {
      await options.onUnexpectedError(outcome.error);
      return options.serializeFailure({
        ok: false,
        status: 500,
        error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
        requestId,
      });
    }
    if (!outcome.result.ok) return options.serializeFailure(outcome.result);
  }

  heartbeat = setInterval(() => {
    if (finished || channel.closed || channel.busy) return;
    if (Date.now() - lastActivityAt < heartbeatMs) return;
    lastActivityAt = Date.now();
    channel.write(encodeSseHeartbeat(lastActivityAt)).catch(() => undefined);
  }, heartbeatMs);
  void complete();

  const headers = new Headers(options.headers);
  headers.set("content-type", HTTP_STREAM_CONTENT_TYPE);
  headers.set("cache-control", "no-store");
  headers.set("x-ship-stream", STREAM_PROTOCOL_HEADER);
  return new Response(channel.readable, { status: 200, headers });
}
