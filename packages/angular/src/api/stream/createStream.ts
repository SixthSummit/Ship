import { type Signal, signal, type WritableSignal } from '@angular/core';
import { ApiError } from '../errors/ApiError';
import { parseSseFrames, type SseFrame } from './sse-parser';

/**
 * Status of a {@link ShipStream}.
 *
 * - `'idle'` — never started (constructor hasn't yet kicked off the request)
 * - `'connecting'` — fetch in flight, no body yet
 * - `'open'` — body started, frames flowing
 * - `'closed'` — body completed normally
 * - `'error'` — fetch failed, response was non-OK, or parser threw
 * - `'aborted'` — explicit `abort()` call
 */
export type ShipStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error' | 'aborted';

/**
 * Reactive SSE stream returned by {@link createStream}.
 *
 * Same `{ events, status, error, abort, reload }` shape regardless of
 * the underlying transport — fetch URL/factory or a Hono `hc()` thunk.
 * Components don't change shape based on the source.
 */
export interface ShipStream<T> {
  /**
   * All events received so far, in arrival order. The signal updates
   * after each parsed SSE frame is mapped through the `decode` option.
   */
  readonly events: Signal<readonly T[]>;
  /** Current connection status. */
  readonly status: Signal<ShipStreamStatus>;
  /** The error from the most recent failed connect/parse, or `undefined`. */
  readonly error: Signal<unknown>;
  /**
   * Abort the in-flight stream. Transitions `status` to `'aborted'`.
   * No-op if already closed / errored.
   */
  abort(): void;
  /**
   * Restart the stream — aborts any in-flight request, clears `events`,
   * and re-fetches from the source.
   */
  reload(): void;
}

/**
 * Decoder mapping a parsed SSE frame to a typed value. Default decoder
 * parses the frame's `data` payload as JSON. Override for non-JSON
 * payloads (text, custom binary-ish encoding) or to inject metadata
 * from `event` / `id`.
 */
export type StreamDecoder<T> = (frame: SseFrame) => T;

/**
 * Default decoder: `JSON.parse(frame.data)`. Skips empty/keep-alive
 * frames (returns `undefined`). Skips `[DONE]` sentinel (Anthropic-style)
 * with the same behaviour.
 */
const defaultDecoder = <T>(frame: SseFrame): T | undefined => {
  if (!frame.data || frame.data === '[DONE]') return undefined;
  try {
    return JSON.parse(frame.data) as T;
  } catch {
    return undefined;
  }
};

/**
 * Options for the URL/factory call shape of {@link createStream}.
 */
export interface CreateStreamOptions<T = unknown, TBody = unknown> {
  /** HTTP method. Default: `'GET'`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Request body (for non-GET methods). Sent as JSON if not a string / FormData / Blob. */
  body?: TBody;
  /** Additional request headers. `Accept: text/event-stream` is set automatically. */
  headers?: Record<string, string>;
  /** Frame → typed value mapper. Default: `JSON.parse(frame.data)`. */
  decode?: StreamDecoder<T | undefined>;
  /** Override `fetch` (e.g., a `withRequestId(fetch)` wrapper). */
  fetch?: typeof fetch;
}

/**
 * Open a reactive SSE stream from a Hono `hc()` thunk that returns a
 * `Response`. Use this when consuming a ShipAPI route that uses
 * `streamSSE(c, ...)` or `streamLLM(c, ...)`.
 *
 * @example Streaming chat against ShipAPI's agentLoop
 * ```ts
 * import { api } from '@/api'; // hc<ShipApiClient>()
 * import { createStream } from '@sixthsummit/ship-angular';
 *
 * const chat = createStream<TextDelta>(async () => {
 *   return await api.agent.stream.$post({ json: { messages } });
 * });
 * // chat.events: Signal<readonly TextDelta[]>
 * ```
 */
export function createStream<T = unknown>(
  thunk: () => Promise<Response>,
  options?: { decode?: StreamDecoder<T | undefined> }
): ShipStream<T>;

/**
 * Open a reactive SSE stream from a URL.
 *
 * @example
 * ```ts
 * const events = createStream<MyEvent>(() => '/api/events');
 * ```
 */
export function createStream<T = unknown, TBody = unknown>(
  url: string | (() => string),
  options?: CreateStreamOptions<T, TBody>
): ShipStream<T>;

export function createStream<T = unknown, TBody = unknown>(
  source: string | (() => string) | (() => Promise<Response>),
  options: CreateStreamOptions<T, TBody> & { decode?: StreamDecoder<T | undefined> } = {}
): ShipStream<T> {
  const events = signal<readonly T[]>([]);
  const status: WritableSignal<ShipStreamStatus> = signal('idle');
  const error = signal<unknown>(undefined);
  let controller: AbortController | undefined;
  const decoder: StreamDecoder<T | undefined> =
    options.decode ?? (defaultDecoder as StreamDecoder<T | undefined>);

  const abort = () => {
    if (status() === 'closed' || status() === 'error') return;
    controller?.abort();
    if (status() !== 'error') status.set('aborted');
  };

  const start = () => {
    controller?.abort();
    controller = new AbortController();
    events.set([]);
    error.set(undefined);
    status.set('connecting');
    runStream(source, options, decoder, controller.signal, status, error, events).catch(
      (e: unknown) => {
        // The runner sets status='error' before throwing — guard to avoid
        // overriding the AbortError surface.
        if (status() !== 'aborted') {
          error.set(e);
          status.set('error');
        }
      }
    );
  };

  start();

  return {
    events: events.asReadonly(),
    status: status.asReadonly(),
    error: error.asReadonly(),
    abort,
    reload: start,
  };
}

async function runStream<T, TBody>(
  source: string | (() => string) | (() => Promise<Response>),
  options: CreateStreamOptions<T, TBody>,
  decoder: StreamDecoder<T | undefined>,
  signal: AbortSignal,
  status: WritableSignal<ShipStreamStatus>,
  error: WritableSignal<unknown>,
  events: WritableSignal<readonly T[]>
): Promise<void> {
  let response: Response;

  if (typeof source === 'function') {
    const probe = (source as () => string | Promise<Response>)();
    if (typeof probe === 'string') {
      response = await fetchUrl(probe, options, signal);
    } else if (probe && typeof (probe as Promise<Response>).then === 'function') {
      response = await (probe as Promise<Response>);
      // hc() thunk doesn't carry our AbortController — best-effort: if
      // signal aborts after the response resolves, the body reader picks
      // it up via the signal we pass to parseSseFrames.
    } else {
      throw new Error('createStream: source must return a URL string or a Promise<Response>');
    }
  } else {
    response = await fetchUrl(source, options, signal);
  }

  if (signal.aborted) {
    status.set('aborted');
    return;
  }

  if (!response.ok) {
    const apiErr = await ApiError.fromResponse(response);
    error.set(apiErr);
    status.set('error');
    return;
  }

  if (!response.body) {
    // No body — empty stream, transition straight to closed.
    status.set('closed');
    return;
  }

  status.set('open');

  for await (const frame of parseSseFrames(response.body, signal)) {
    if (signal.aborted) {
      status.set('aborted');
      return;
    }
    const decoded = decoder(frame);
    if (decoded !== undefined) {
      events.update(prev => [...prev, decoded]);
    }
  }

  if (signal.aborted) {
    status.set('aborted');
    return;
  }
  status.set('closed');
}

async function fetchUrl<T, TBody>(
  url: string,
  options: CreateStreamOptions<T, TBody>,
  signal: AbortSignal
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...(options.headers ?? {}),
  };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (
      typeof options.body === 'string' ||
      options.body instanceof FormData ||
      options.body instanceof Blob ||
      options.body instanceof ArrayBuffer ||
      options.body instanceof URLSearchParams
    ) {
      body = options.body as BodyInit;
    } else {
      body = JSON.stringify(options.body);
      if (!('Content-Type' in headers) && !('content-type' in headers)) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }
  return fetchImpl(url, {
    method: options.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
    signal,
  });
}
