import type { ClientContractOperation, ClientContractStreamResponse } from "./manifest.js";
import { createSseParser } from "./sse.js";

export type OperationStreamStatus = "connecting" | "open" | "closed" | "error" | "aborted";

export interface OperationStreamError {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details?: unknown;
}

export interface OperationStreamMetadata {
  readonly requestId: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Handle returned synchronously for streaming operations. `frames` is a
 * single-pass async iterable that ends when the stream closes, errors, or is
 * aborted; `terminal` resolves with the terminal value, or `undefined` when
 * the stream ended with an error event, a transport interruption, or abort.
 * Both reject only for client-side misuse (invalid input, codec, contract).
 */
export interface OperationStreamHandle<TFrame = unknown, TTerminal = unknown> {
  readonly frames: AsyncIterable<TFrame>;
  readonly terminal: Promise<TTerminal | undefined>;
  abort(): void;
  readonly status: OperationStreamStatus;
  readonly error?: OperationStreamError;
  readonly requestId?: string;
  readonly metadata?: OperationStreamMetadata;
}

/** Locally generated code for a stream that failed or closed without a terminal or error event. */
export const STREAM_INTERRUPTED = "STREAM_INTERRUPTED";

export interface OpenStreamOptions {
  readonly operation: ClientContractOperation;
  readonly response: ClientContractStreamResponse;
  readonly signal?: AbortSignal;
  /** Prepares and sends the request; receives the handle's abort signal. */
  readonly send: (signal: AbortSignal) => Promise<Response>;
  readonly decodeFrame: (value: unknown) => Promise<unknown>;
  readonly decodeTerminal: (value: unknown) => Promise<unknown>;
}

interface FrameQueue<TValue> {
  push(value: TValue): void;
  end(): void;
  fail(error: unknown): void;
  readonly iterable: AsyncIterable<TValue>;
}

function createFrameQueue<TValue>(): FrameQueue<TValue> {
  const values: TValue[] = [];
  let done = false;
  let failure: { readonly error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push(value) {
      if (done) return;
      values.push(value);
      notify();
    },
    end() {
      done = true;
      notify();
    },
    fail(error) {
      if (done) return;
      failure = { error };
      done = true;
      notify();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (values.length > 0) {
            yield values.shift() as TValue;
            continue;
          }
          if (done) {
            if (failure) throw failure.error;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

export function openOperationStream(options: OpenStreamOptions): OperationStreamHandle {
  const controller = new AbortController();
  const queue = createFrameQueue<unknown>();
  let status: OperationStreamStatus = "connecting";
  let error: OperationStreamError | undefined;
  let requestId: string | undefined;
  let metadata: OperationStreamMetadata | undefined;
  let resolveTerminal: (value: unknown) => void = () => {};
  let rejectTerminal: (reason: unknown) => void = () => {};
  const terminal = new Promise<unknown>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  const settled = () => status === "closed" || status === "error" || status === "aborted";

  const finish = (nextStatus: OperationStreamStatus, streamError?: OperationStreamError) => {
    if (settled()) return;
    status = nextStatus;
    error = streamError;
    queue.end();
    resolveTerminal(undefined);
  };
  const interrupted = (message: string) =>
    finish("error", { code: STREAM_INTERRUPTED, status: 0, message });

  const abort = () => {
    if (settled()) return;
    finish("aborted");
    controller.abort();
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  const consume = async (response: Response): Promise<void> => {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    requestId = response.headers.get("x-request-id") ?? undefined;
    metadata = Object.freeze({
      requestId: requestId ?? "",
      headers: Object.freeze(
        Object.fromEntries(
          [...response.headers].sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    });
    if (contentType !== "text/event-stream") {
      if (contentType === "application/json" || contentType?.endsWith("+json")) {
        const envelope = await response.json().catch(() => undefined);
        const payload = envelopeError(envelope);
        if (payload) {
          finish("error", { ...payload, status: response.status });
          return;
        }
      }
      interrupted(`stream ${JSON.stringify(options.operation.id)} did not return an event stream`);
      return;
    }
    if (response.status !== 200 || !response.body) {
      interrupted(
        `stream ${JSON.stringify(options.operation.id)} opened with status ${response.status}`,
      );
      return;
    }
    status = "open";
    const parser = createSseParser();
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        const events = done ? parser.end() : parser.push(value);
        for (const event of events) {
          if (event.event === "frame") {
            queue.push(await options.decodeFrame(parseData(event.data)));
            continue;
          }
          if (event.event === "terminal") {
            const data = parseData(event.data);
            const decoded = data === null ? undefined : await options.decodeTerminal(data);
            status = "closed";
            queue.end();
            resolveTerminal(decoded);
            await reader.cancel().catch(() => undefined);
            return;
          }
          if (event.event === "error") {
            const payload = errorFrame(parseData(event.data));
            if (payload) finish("error", payload);
            else interrupted("stream error event is malformed");
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
        if (done) break;
      }
      interrupted("stream closed without a terminal or error event");
    } finally {
      reader.releaseLock();
    }
  };

  void (async () => {
    try {
      if (controller.signal.aborted) return;
      const response = await options.send(controller.signal);
      if (controller.signal.aborted) return;
      await consume(response);
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (isClientError(caught)) {
        status = "error";
        error = { code: caught.code, status: 0, message: caught.message };
        queue.fail(caught);
        rejectTerminal(caught);
        return;
      }
      interrupted(caught instanceof Error ? caught.message : "stream transport failed");
    }
  })();

  return Object.freeze({
    frames: queue.iterable,
    terminal,
    abort,
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get requestId() {
      return requestId;
    },
    get metadata() {
      return metadata;
    },
  });
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new TypeError("stream event data is not valid JSON");
  }
}

function isClientError(value: unknown): value is Error & { readonly code: string } {
  return (
    value instanceof Error &&
    value.name === "OperationClientError" &&
    typeof Reflect.get(value, "code") === "string"
  );
}

function errorFrame(value: unknown): OperationStreamError | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code = Reflect.get(value, "code");
  const status = Reflect.get(value, "status");
  const message = Reflect.get(value, "message");
  if (typeof code !== "string" || typeof status !== "number" || typeof message !== "string") {
    return undefined;
  }
  const details = Reflect.get(value, "details");
  return Object.freeze({ code, status, message, ...(details === undefined ? {} : { details }) });
}

function envelopeError(value: unknown): Omit<OperationStreamError, "status"> | undefined {
  if (typeof value !== "object" || value === null || Reflect.get(value, "success") !== false) {
    return undefined;
  }
  const payload = Reflect.get(value, "error");
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof Reflect.get(payload, "code") !== "string" ||
    typeof Reflect.get(payload, "message") !== "string"
  ) {
    return undefined;
  }
  const details = Reflect.get(payload, "details");
  return Object.freeze({
    code: Reflect.get(payload, "code") as string,
    message: Reflect.get(payload, "message") as string,
    ...(details === undefined ? {} : { details }),
  });
}
