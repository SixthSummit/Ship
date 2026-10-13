import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import { streamSSE as honoStreamSSE } from "hono/streaming";
import { withSpan } from "../../observability/tracing.js";

/**
 * `streamSSE(c, fn, opts?)` — framework wrapper around `hono/streaming`'s
 * SSE helper. Adds an OTel span around the streaming callback's lifetime
 * and a documented home for v4.x SSE-related helpers (LLM streaming, etc.).
 *
 * Re-exports `SSEStreamingApi` so consumers don't have to import from two
 * paths to type their stream callback.
 *
 * Usage:
 * ```ts
 * import { streamSSE } from "@sixthsummit/ship-api/http/streaming/sse";
 *
 * app.get("/feed", requireAuth({ provider }), (c) =>
 *   streamSSE(c, async (stream) => {
 *     for await (const event of someEventSource()) {
 *       if (stream.aborted) break; // honor client disconnect
 *       await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
 *     }
 *   }, { spanName: "feed.subscribe" }),
 * );
 * ```
 */

export type { SSEStreamingApi };

export interface StreamSSEOptions {
  /** OTel span name. Default `"http.sse"`. */
  spanName?: string;
}

export function streamSSE(
  c: Context,
  fn: (stream: SSEStreamingApi) => Promise<void>,
  opts: StreamSSEOptions = {},
): Response {
  const spanName = opts.spanName ?? "http.sse";
  return honoStreamSSE(c, async (stream) => {
    await withSpan(spanName, async () => {
      await fn(stream);
    });
  });
}
