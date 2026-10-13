import type { StreamEvent } from "../types.js";

/**
 * Structural view of the kernel stream seam handed to streaming operation
 * handlers (`OperationStream` from `@sixthsummit/ship-core`). Declared here so
 * the library keeps zero runtime or type dependencies on the kernel package.
 */
export interface LLMFrameStream<TFrame> {
  readonly emit: (frame: TFrame) => Promise<void>;
  readonly signal: AbortSignal;
}

/**
 * Minimum shape `streamLLM` requires: a string `type` plus JSON-serializable
 * fields. The full `StreamEvent` union from this library fits.
 */
export interface LLMStreamFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface StreamLLMOptions<TFrame extends LLMStreamFrame> {
  /**
   * Called once if the provider iterator throws, before the error propagates
   * to the kernel (which delivers it as a terminal `error` frame). Throwing
   * here is swallowed so the propagation still completes.
   */
  readonly onError?: (error: Error) => Promise<void> | void;
  /**
   * Maps a provider event onto the operation's declared frame. Defaults to
   * passing the event through unchanged.
   */
  readonly toFrame?: (event: StreamEvent | LLMStreamFrame, index: number) => TFrame;
}

export interface StreamLLMResult {
  /** Number of frames handed to `emit`. */
  readonly frames: number;
  /** True when the run stopped early because the operation signal aborted. */
  readonly aborted: boolean;
}

/**
 * `streamLLM(stream, events, options?)` — pipes an LLM provider stream
 * (typically `LLMProvider.streamComplete()`) through the kernel stream seam.
 * Each provider event becomes one validated frame; cancellation flows from the
 * operation's `AbortSignal` back into the provider iterator via `return()`.
 *
 * This is the operation-kernel counterpart of the compatibility
 * `streamLLM(c, events)` Hono helper in `@sixthsummit/ship-api`, whose SSE
 * layout (`event: <type>`) is unchanged. Under the kernel the frame is the
 * whole event object and the SSE event name is always `frame`.
 *
 * Usage:
 * ```ts
 * handler: async ({ input, services, stream }) => {
 *   const events = services.llm.streamComplete({ model, messages, signal: stream.signal });
 *   const { frames } = await streamLLM(stream, events);
 *   return { frames };
 * }
 * ```
 */
export async function streamLLM<TFrame extends LLMStreamFrame = StreamEvent>(
  stream: LLMFrameStream<TFrame>,
  events: AsyncIterable<StreamEvent | LLMStreamFrame>,
  options: StreamLLMOptions<TFrame> = {},
): Promise<StreamLLMResult> {
  const toFrame = options.toFrame ?? ((event) => event as TFrame);
  const iterator = events[Symbol.asyncIterator]();
  let frames = 0;
  try {
    while (true) {
      if (stream.signal.aborted) {
        await iterator.return?.();
        return { frames, aborted: true };
      }
      const next = await iterator.next();
      if (next.done) return { frames, aborted: false };
      await stream.emit(toFrame(next.value, frames));
      frames += 1;
    }
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    if (options.onError) {
      try {
        await options.onError(error);
      } catch {
        // The hook must not mask the original failure.
      }
    }
    await iterator.return?.().catch(() => undefined);
    throw error;
  }
}
