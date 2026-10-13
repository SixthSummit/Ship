import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * Tracer name used framework-wide. Consumers can call `getTracer(name)` with
 * a domain-specific name for finer-grained filtering in their backend.
 */
export const TRACER_NAME = "@sixthsummit/ship-api";

export function getTracer(name = TRACER_NAME) {
  return trace.getTracer(name);
}

/**
 * Run `fn` inside an active span, capturing duration + exception status.
 *
 * - Sets `OK` status on success, `ERROR` (with the exception) on throw.
 * - Calls `span.end()` even on throw — no leaked spans.
 * - Re-throws the original error so callers don't have to know about spans.
 *
 * When the OTel SDK is not started (e.g., in tests, or with
 * `OTEL_SDK_DISABLED=true`), the API returns a no-op tracer and this is a
 * thin pass-through with the same shape — callers do not need to guard.
 *
 * @example
 * await withSpan("accountService.create", async () => {
 *   await accountService.create(values);
 * }, { "account.email": values.email });
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attrs?: Attributes,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attrs) span.setAttributes(attrs);
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      span.end();
    }
  });
}
