import type { Context } from "hono";
import { logger as defaultLogger } from "../../observability/logger.js";
import { getFrameworkMeter } from "../../observability/metrics.js";
import { type SSEStreamingApi, streamSSE } from "./sse.js";

/**
 * Default maximum bytes per SSE event payload (F15). 256 KB is far
 * above any reasonable single LLM stream chunk (a typical Claude /
 * GPT token-delta is ~1–200 bytes; a tool-call argument blob is
 * ~kilobytes) and well below the bandwidth-amplification threshold
 * that turns one bad upstream event into a DoS surface.
 *
 * Per-stream override via `StreamLLMOptions.maxEventBytes`.
 */
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

/**
 * OTel counter incremented every time a streaming event exceeds the
 * size cap and is dropped. Operators alert on this — a nonzero rate
 * indicates either a misbehaving provider or an under-sized cap.
 */
const droppedOversizedCounter = (() => {
  const meter = getFrameworkMeter("ship-api.streaming");
  return meter.createCounter("stream.event.dropped_oversized", {
    description:
      "Streaming events skipped by streamLLM/streamSSE because their " +
      "serialized payload exceeded maxEventBytes. Tag `provider` is " +
      "the LLM provider id when known, else the event's `type`.",
  });
})();

/**
 * `streamLLM(c, events, opts?)` — Hono-aware SSE bridge for LLM stream
 * events. Pipes any `AsyncIterable<{ type, ... }>` (typically the
 * `streamComplete()` output of an `LLMProvider` adapter from
 * `libraries/ai`) through `streamSSE`, with client-disconnect
 * propagation upstream.
 *
 * Event format:
 *   - `event:` field = the iterator value's `type` field
 *   - `data:` field = JSON-serialized rest of the value (everything
 *     except `type`)
 *
 * Disconnect handling: when the request client disconnects,
 * `stream.aborted` flips true. We notice between iterator ticks and
 * call `iterator.return?.()` so the upstream generator can run its
 * `finally` (closes provider stream, cancels in-flight HTTP, etc.).
 *
 * Errors: if the iterator throws, the error is forwarded as a final
 * `event: error` SSE event with `{ message }` payload, then the
 * stream closes. The optional `onError` hook is called *before* the
 * error event is written so consumers can log / record without
 * blocking the close.
 *
 * Provider-agnostic by design — no import from `libraries/ai`. The
 * library's `StreamEvent` union (`start` / `text_delta` /
 * `tool_use_*` / `stop`) is just one valid event source; consumers
 * with a different shape (custom event taxonomy) can pipe through
 * unchanged.
 *
 * Usage:
 * ```ts
 * import { streamLLM } from "@sixthsummit/ship-api/http/streaming/streamLLM";
 * import { AnthropicAdapter } from "@sixthsummit/ship-api/libraries/ai";
 *
 * const llm = new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY });
 *
 * app.post("/chat", validate("json", schema), async (c) => {
 *   const { prompt } = c.req.valid("json");
 *   const stream = llm.streamComplete({
 *     model: "claude-opus-4-7",
 *     messages: [{ role: "user", content: prompt }],
 *   });
 *   return streamLLM(c, stream, { spanName: "chat.stream" });
 * });
 * ```
 */

export interface StreamLLMOptions {
  /** OTel span name. Default `"llm.stream"`. */
  spanName?: string;
  /**
   * Called once if the upstream iterator throws, before the final
   * `event: error` SSE write. Use to log / record the failure;
   * throwing here is swallowed so the close still completes.
   */
  onError?: (err: Error) => Promise<void> | void;
  /**
   * Override how the SSE event id field is generated. Defaults to a
   * monotonically-incrementing counter — sufficient for replay scope
   * within a single response.
   */
  generateEventId?: (event: LLMStreamEvent, index: number) => string;
  /**
   * Maximum serialized bytes per event payload (F15). Events whose
   * `JSON.stringify(payload)` exceeds this are skipped + logged +
   * counted on the `stream.event.dropped_oversized` OTel counter.
   * Default 256 KB. A misbehaving upstream provider that emits
   * multi-megabyte single events (e.g. a duplicated tool-call
   * argument) would otherwise amplify into a bandwidth + client-
   * memory DoS at the consumer.
   */
  maxEventBytes?: number;
  /**
   * Tag attached to the `dropped_oversized` counter and the warn
   * line emitted on oversize. Useful for distinguishing "Anthropic
   * stream went wild" from "OpenAI stream went wild" in dashboards.
   * Defaults to the event's `type` field at log time.
   */
  provider?: string;
  /** Override the framework default pino logger (tests). */
  logger?: typeof defaultLogger;
}

/**
 * Minimum shape `streamLLM` requires. Any object with a string `type`
 * and arbitrary other JSON-serializable fields fits — including the
 * full `StreamEvent` union from `libraries/ai`.
 */
export interface LLMStreamEvent {
  type: string;
  [key: string]: unknown;
}

export function streamLLM(
  c: Context,
  events: AsyncIterable<LLMStreamEvent>,
  opts: StreamLLMOptions = {},
): Response {
  const spanName = opts.spanName ?? "llm.stream";
  const maxEventBytes = opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const log = opts.logger ?? defaultLogger;

  return streamSSE(
    c,
    async (stream) => {
      let index = 0;
      const iterator = events[Symbol.asyncIterator]();
      try {
        while (true) {
          if (stream.aborted) {
            // Client disconnected — give the provider iterator a chance
            // to clean up (close upstream HTTP, abort SDK request).
            await iterator.return?.();
            return;
          }
          const next = await iterator.next();
          if (next.done) return;
          await writeEvent(
            stream,
            next.value,
            index,
            opts.generateEventId,
            maxEventBytes,
            opts.provider,
            log,
          );
          index++;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (opts.onError) {
          try {
            await opts.onError(error);
          } catch {
            // Swallow — caller-provided hook must not break the close.
          }
        }
        if (!stream.aborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: error.message }),
          });
        }
        // Best-effort upstream cleanup.
        await iterator.return?.().catch(() => undefined);
      }
    },
    { spanName },
  );
}

async function writeEvent(
  stream: SSEStreamingApi,
  event: LLMStreamEvent,
  index: number,
  generateEventId: ((event: LLMStreamEvent, index: number) => string) | undefined,
  maxEventBytes: number,
  provider: string | undefined,
  log: typeof defaultLogger,
): Promise<void> {
  const { type, ...payload } = event;
  const id = generateEventId ? generateEventId(event, index) : String(index);
  const data = JSON.stringify(payload);
  const eventBytes = Buffer.byteLength(data, "utf8");

  if (eventBytes > maxEventBytes) {
    const providerTag = provider ?? type;
    const sampleTail = data.slice(Math.max(0, data.length - 256));
    log.warn(
      {
        provider: providerTag,
        eventType: type,
        eventBytes,
        maxEventBytes,
        sampleTail,
      },
      "stream.event.dropped_oversized",
    );
    droppedOversizedCounter.add(1, { provider: providerTag });
    return;
  }

  await stream.writeSSE({
    id,
    event: type,
    data,
  });
}
