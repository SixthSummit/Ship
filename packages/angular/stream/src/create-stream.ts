import { type Signal, signal } from '@angular/core';
import {
  failureFromResponse,
  type InputOf,
  type StreamOperationId,
} from '@sixthsummit/ship-angular/operations';
import { buildStreamRequest, type ShipStreamRequest } from './build-stream-request';
import { parseSseFrames } from './parse-sse-frames';
import { resolveStreamPlatform, type ShipStreamPlatform } from './resolve-stream-platform';
import type { StreamFrameOf, StreamTerminalOf } from './ship-stream-contract';
import {
  isShipStreamError,
  type ShipStreamError,
  STREAM_INTERRUPTED,
  STREAM_PROTOCOL_VIOLATION,
  STREAM_TRANSPORT_FAILED,
} from './ship-stream-error';
import {
  resolveShipStreamOperation,
  type ShipStreamManifest,
  type ShipStreamMethod,
} from './ship-stream-manifest';

/**
 * Lifecycle of a {@link ShipStreamHandle}.
 *
 * A stream that starts successfully walks `connecting → open → closed`. Every
 * other ending is terminal too: `error` (a wire error event, a pre-first-frame
 * error envelope, or a local failure) and `aborted` (the caller cancelled).
 * `idle` means no request was opened — the SSR branch.
 */
export type ShipStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error' | 'aborted';

/** Signal-first handle over one SSE stream. */
export interface ShipStreamHandle<TFrame, TTerminal> {
  /** Every frame received so far, oldest first, bounded by the declared `maxFrames`. */
  readonly frames: Signal<readonly TFrame[]>;
  /** The most recent frame, or `undefined` before the first one. */
  readonly latest: Signal<TFrame | undefined>;
  /** The decoded terminal payload once a `terminal` event arrives. */
  readonly terminal: Signal<TTerminal | undefined>;
  /** Current lifecycle state. */
  readonly status: Signal<ShipStreamStatus>;
  /** The wire or local error that ended the stream. */
  readonly error: Signal<ShipStreamError | undefined>;
  /** The last SSE `id:` sequence number observed. `0` before the first event. */
  readonly seq: Signal<number>;
  /** Cancel the request. Transitions to `aborted` unless the stream already ended. */
  abort(): void;
}

/** A stream request assembled by the caller rather than read from the manifest. */
export interface ShipStreamSourceRequest {
  readonly url: string;
  readonly method?: ShipStreamMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** A manifest-declared stream operation together with its typed input. */
export interface ShipStreamOperationRef<
  TContract extends object,
  TId extends StreamOperationId<TContract>,
> {
  /** The ShipAPI manifest projection this operation is declared in. */
  readonly manifest: ShipStreamManifest;
  /** Stable operation ID. */
  readonly operation: TId;
  /** Contract-typed operation input (`params` / `query` / `body`). */
  readonly input: InputOf<TContract, TId>;
  /** Absolute origin (optionally with a path prefix) the manifest paths are joined to. */
  readonly baseUrl: string;
}

export interface CreateStreamOptions<TFrame, TTerminal> {
  /** Override `fetch` (a policy-wrapped fetch, a test double). */
  readonly fetch?: typeof fetch;
  /** External cancellation. Aborting it aborts the stream. */
  readonly signal?: AbortSignal;
  /** Extra request headers. `Accept` is set by the wire contract and cannot be replaced. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
  /** Force the SSR branch. Defaults to `PLATFORM_ID` when an injection context exists. */
  readonly platform?: ShipStreamPlatform;
  /** Retained frame history. Defaults to the operation's declared `limits.maxFrames`. */
  readonly maxFrames?: number;
  /** Called for each decoded frame, for consumers that do not want retained history. */
  readonly onFrame?: (frame: TFrame, seq: number) => void;
  /** Frame decoder. Default: `JSON.parse`. */
  readonly decodeFrame?: (data: string) => TFrame;
  /** Terminal decoder. Default: `JSON.parse`, mapping `null` to `undefined`. */
  readonly decodeTerminal?: (data: string) => TTerminal | undefined;
}

const DEFAULT_MAX_FRAMES = 1_000;

/**
 * Open a manifest-typed SSE stream.
 *
 * `Frame` and `Terminal` are inferred from the contract's stream operation, the
 * request is built from the manifest's declared method/path, and the response is
 * read against the canonical wire contract: `Accept: text/event-stream`, a
 * Content-Type branch for pre-first-frame errors, `frame` / `terminal` / `error`
 * events with `id:` sequence numbers, and ignored heartbeat comments.
 *
 * @example
 * ```ts
 * const run = createStream<AppContract, 'agent.run'>({
 *   manifest,
 *   operation: 'agent.run',
 *   input: { body: { prompt } },
 *   baseUrl: environment.apiBaseUrl,
 * });
 * // run.latest(): Signal<TextDelta | undefined>
 * ```
 */
export function createStream<TContract extends object, TId extends StreamOperationId<TContract>>(
  source: ShipStreamOperationRef<TContract, TId>,
  options?: CreateStreamOptions<StreamFrameOf<TContract, TId>, StreamTerminalOf<TContract, TId>>
): ShipStreamHandle<StreamFrameOf<TContract, TId>, StreamTerminalOf<TContract, TId>>;

/**
 * Open an SSE stream against an explicit request.
 *
 * Same wire contract, without the manifest: use it for an endpoint ShipAPI has
 * not projected yet, and supply the frame types yourself.
 */
export function createStream<TFrame = unknown, TTerminal = unknown>(
  source: string | ShipStreamSourceRequest,
  options?: CreateStreamOptions<TFrame, TTerminal>
): ShipStreamHandle<TFrame, TTerminal>;

// The implementation signature is erased by the two overloads above; `any` here keeps
// the public surface exact while letting both call shapes share one runtime. The
// arguments are immediately re-bound to their real types.
export function createStream(source: any, received: any = {}): ShipStreamHandle<any, any> {
  type TFrame = any;
  type TTerminal = any;
  const streamSource: string | ShipStreamSourceRequest | AnyStreamOperationRef = source;
  const options: CreateStreamOptions<TFrame, TTerminal> = received;
  const frames = signal<readonly TFrame[]>([]);
  const latest = signal<TFrame | undefined>(undefined);
  const terminal = signal<TTerminal | undefined>(undefined);
  const status = signal<ShipStreamStatus>('idle');
  const error = signal<ShipStreamError | undefined>(undefined);
  const seq = signal(0);
  const controller = new AbortController();

  const fail = (value: ShipStreamError): void => {
    error.set(value);
    status.set('error');
  };

  const abort = (): void => {
    if (status() === 'closed' || status() === 'error' || status() === 'aborted') return;
    controller.abort();
    status.set('aborted');
  };

  const handle: ShipStreamHandle<TFrame, TTerminal> = {
    frames: frames.asReadonly(),
    latest: latest.asReadonly(),
    terminal: terminal.asReadonly(),
    status: status.asReadonly(),
    error: error.asReadonly(),
    seq: seq.asReadonly(),
    abort,
  };

  // SSR renders the handle's initial state and opens nothing.
  if (resolveStreamPlatform(options.platform) === 'server') return handle;

  let plan: StreamPlan;
  try {
    plan = planStream(streamSource, options.maxFrames);
  } catch (caught: unknown) {
    fail(localError(STREAM_PROTOCOL_VIOLATION, describe(caught)));
    return handle;
  }

  if (options.signal !== undefined) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  }

  void runStream(plan, options, controller, { frames, latest, terminal, status, seq }, fail);
  return handle;
}

interface AnyStreamOperationRef {
  readonly manifest: ShipStreamManifest;
  /** `StreamOperationId<TContract>` is not provably a string in a generic position. */
  readonly operation: unknown;
  readonly input: unknown;
  readonly baseUrl: string;
}

interface StreamPlan {
  readonly request: ShipStreamRequest;
  readonly declaredErrorCodes: readonly string[];
  readonly maxFrames: number;
}

interface StreamState<TFrame, TTerminal> {
  readonly frames: { (): readonly TFrame[]; set(value: readonly TFrame[]): void };
  readonly latest: { set(value: TFrame | undefined): void };
  readonly terminal: { set(value: TTerminal | undefined): void };
  readonly status: { (): ShipStreamStatus; set(value: ShipStreamStatus): void };
  readonly seq: { (): number; set(value: number): void };
}

function planStream(
  source: string | ShipStreamSourceRequest | AnyStreamOperationRef,
  maxFramesOverride: number | undefined
): StreamPlan {
  if (typeof source === 'string') {
    return {
      request: { url: source, method: 'GET', headers: { accept: 'text/event-stream' } },
      declaredErrorCodes: [],
      maxFrames: maxFramesOverride ?? DEFAULT_MAX_FRAMES,
    };
  }
  if (isOperationRef(source)) {
    const operation = resolveShipStreamOperation(source.manifest, String(source.operation));
    return {
      request: buildStreamRequest(source.baseUrl, operation, source.input),
      declaredErrorCodes: operation.declaredErrorCodes,
      maxFrames: maxFramesOverride ?? operation.response.limits.maxFrames,
    };
  }
  return {
    request: {
      url: source.url,
      method: source.method ?? 'GET',
      headers: { accept: 'text/event-stream', ...(source.headers ?? {}) },
      ...(source.body === undefined ? {} : { body: source.body }),
    },
    declaredErrorCodes: [],
    maxFrames: maxFramesOverride ?? DEFAULT_MAX_FRAMES,
  };
}

async function runStream<TFrame, TTerminal>(
  plan: StreamPlan,
  options: CreateStreamOptions<TFrame, TTerminal>,
  controller: AbortController,
  state: StreamState<TFrame, TTerminal>,
  fail: (value: ShipStreamError) => void
): Promise<void> {
  const decodeFrame = options.decodeFrame ?? ((data: string) => JSON.parse(data) as TFrame);
  const decodeTerminal =
    options.decodeTerminal ??
    ((data: string) => {
      const value: unknown = JSON.parse(data);
      return value === null ? undefined : (value as TTerminal);
    });

  state.status.set('connecting');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(plan.request.url, {
      method: plan.request.method,
      headers: { ...lowercaseHeaders(options.headers), ...plan.request.headers },
      ...(plan.request.body === undefined ? {} : { body: plan.request.body }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (caught: unknown) {
    if (controller.signal.aborted) state.status.set('aborted');
    else fail(localError(STREAM_TRANSPORT_FAILED, describe(caught)));
    return;
  }

  if (controller.signal.aborted) {
    state.status.set('aborted');
    return;
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('json')) {
    // Per the wire contract, a failure before the first frame is the normal JSON
    // error envelope with its normal status.
    try {
      const failure = await failureFromResponse(response, plan.declaredErrorCodes);
      fail({
        code: failure.error.code,
        status: failure.status,
        message: failure.error.message,
        ...(failure.error.details === undefined ? {} : { details: failure.error.details }),
      });
    } catch (caught: unknown) {
      fail(localError(STREAM_PROTOCOL_VIOLATION, describe(caught)));
    }
    return;
  }
  if (!contentType.startsWith('text/event-stream')) {
    fail(
      localError(
        STREAM_PROTOCOL_VIOLATION,
        `The stream response declared Content-Type "${response.headers.get('content-type') ?? ''}" with status ${response.status}`
      )
    );
    return;
  }
  if (response.status !== 200) {
    fail(
      localError(
        STREAM_PROTOCOL_VIOLATION,
        `A stream response must use status 200, received ${response.status}`
      )
    );
    return;
  }
  if (response.body === null) {
    fail(localError(STREAM_INTERRUPTED, 'The stream response had no body'));
    return;
  }

  state.status.set('open');
  let settled = false;
  try {
    for await (const event of parseSseFrames(response.body, controller.signal)) {
      const sequence = Number(event.id);
      if (Number.isInteger(sequence) && sequence > 0) state.seq.set(sequence);

      if (event.event === 'frame') {
        const frame = decodeFrame(event.data);
        appendFrame(state, frame, plan.maxFrames);
        options.onFrame?.(frame, state.seq());
        continue;
      }
      if (event.event === 'terminal') {
        state.terminal.set(decodeTerminal(event.data));
        settled = true;
        state.status.set('closed');
        break;
      }
      if (event.event === 'error') {
        const wire: unknown = JSON.parse(event.data);
        if (!isShipStreamError(wire)) {
          throw new TypeError('The stream error event did not carry the wire error object');
        }
        fail(wire);
        settled = true;
        break;
      }
      // Unknown and unnamed events are ignored, as are `: hb <ms>` comments.
    }
  } catch (caught: unknown) {
    if (controller.signal.aborted) {
      state.status.set('aborted');
      return;
    }
    fail(localError(STREAM_PROTOCOL_VIOLATION, describe(caught)));
    return;
  } finally {
    // Release the socket as soon as the stream has said its last word.
    if (settled) controller.abort();
  }

  if (controller.signal.aborted && !settled) {
    state.status.set('aborted');
    return;
  }
  if (!settled) {
    fail(localError(STREAM_INTERRUPTED, 'The stream closed without a terminal or error event'));
  }
}

function appendFrame<TFrame, TTerminal>(
  state: StreamState<TFrame, TTerminal>,
  frame: TFrame,
  maxFrames: number
): void {
  const appended = [...state.frames(), frame];
  state.frames.set(
    appended.length > maxFrames ? appended.slice(appended.length - maxFrames) : appended
  );
  state.latest.set(frame);
}

function isOperationRef(
  source: ShipStreamSourceRequest | AnyStreamOperationRef
): source is AnyStreamOperationRef {
  return 'manifest' in source && 'operation' in source;
}

function lowercaseHeaders(
  headers: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
}

/**
 * Build a locally-reported error.
 *
 * Local errors always carry `status: 0`: no server ever named them, so an HTTP
 * status here would be an invention. The server's own status only appears in
 * `error()` when it came from a wire error event or a JSON error envelope.
 */
function localError(code: string, message: string): ShipStreamError {
  return { code, status: 0, message };
}

function describe(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  return 'The stream failed for an unknown reason';
}
