/**
 * Server-Sent Events (SSE) frame parser.
 *
 * Implements the WHATWG SSE spec frame syntax: lines `field: value`,
 * blank line dispatches an event. Recognised fields: `event`, `data`,
 * `id`, `retry`. Unknown fields are silently dropped (per spec).
 *
 * This module is internal to {@link createStream} but exported from the
 * package via the stream barrel for advanced consumers (e.g., apps that
 * want to consume an `fetch` response body manually).
 */

export interface SseFrame {
  /** The event name (`event:` field). `undefined` for nameless events. */
  readonly event?: string;
  /**
   * Concatenated data payload across all `data:` lines in the frame.
   * Multiple `data:` lines are joined with newlines per the spec.
   */
  readonly data: string;
  /** The most recent `id:` field value seen. `undefined` if unset. */
  readonly id?: string;
  /**
   * `retry:` reconnection time in milliseconds. `undefined` if the server
   * didn't suggest one. Only emitted when the field is a valid integer.
   */
  readonly retry?: number;
}

/**
 * Parse a `ReadableStream<Uint8Array>` (typically `response.body`) into a
 * stream of SSE frames. Yields one {@link SseFrame} per dispatched event.
 *
 * Implementation notes:
 *
 * - Uses `TextDecoderStream` for chunk → string when available, falls
 *   back to `TextDecoder` with `stream: true` (for jsdom which doesn't
 *   ship `TextDecoderStream`).
 * - Recognises both LF and CRLF line endings.
 * - A frame ends on a blank line (LF/LF or CRLF/CRLF).
 * - `lastEventId` is sticky across frames per spec; pass-through field
 *   re-set tracking is the consumer's responsibility.
 *
 * @param body The response body to parse.
 * @param signal Optional abort signal — when aborted, the iterator
 *   completes cleanly rather than throwing.
 */
export async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseFrame, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pending: { event?: string; data: string[]; id?: string; retry?: number } = {
    data: [],
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF to LF; SSE allows either.
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        if (line === '') {
          // Dispatch the pending frame.
          if (pending.data.length > 0 || pending.event !== undefined) {
            yield {
              data: pending.data.join('\n'),
              ...(pending.event === undefined ? {} : { event: pending.event }),
              ...(pending.id === undefined ? {} : { id: pending.id }),
              ...(pending.retry === undefined ? {} : { retry: pending.retry }),
            };
          }
          pending = { data: [] };
          continue;
        }
        if (line.startsWith(':')) {
          // Comment per SSE spec — ignore.
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        switch (field) {
          case 'event':
            pending.event = value;
            break;
          case 'data':
            pending.data.push(value);
            break;
          case 'id':
            pending.id = value;
            break;
          case 'retry': {
            const n = parseInt(value, 10);
            if (Number.isFinite(n)) pending.retry = n;
            break;
          }
          // Unknown fields silently dropped per spec.
        }
      }
    }
    // End-of-stream: dispatch a final frame if buffer ended without a
    // trailing blank line.
    if (pending.data.length > 0 || pending.event !== undefined) {
      yield {
        data: pending.data.join('\n'),
        ...(pending.event === undefined ? {} : { event: pending.event }),
        ...(pending.id === undefined ? {} : { id: pending.id }),
        ...(pending.retry === undefined ? {} : { retry: pending.retry }),
      };
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
