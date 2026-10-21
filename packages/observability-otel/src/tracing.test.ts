import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTracer, TRACER_NAME, withSpan } from "./tracing.js";

let exporter: InMemorySpanExporter;
let provider: TracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  exporter.reset();
});

function finished(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

describe("getTracer", () => {
  it("returns a tracer that can produce spans", () => {
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    const span = tracer.startSpan("ad-hoc");
    span.end();
    expect(finished()).toHaveLength(1);
    expect(finished()[0].name).toBe("ad-hoc");
  });

  it("uses the framework default tracer name when called with no args", () => {
    expect(TRACER_NAME).toBe("@sixthsummit/ship-api");
    const tracer = getTracer();
    const span = tracer.startSpan("named");
    span.end();
    expect(finished()[0].instrumentationScope.name).toBe(TRACER_NAME);
  });

  it("forwards a custom tracer name", () => {
    const tracer = getTracer("my.module");
    const span = tracer.startSpan("named");
    span.end();
    expect(finished()[0].instrumentationScope.name).toBe("my.module");
  });
});

describe("withSpan", () => {
  it("returns the function's resolved value", async () => {
    const result = await withSpan("test.op", async () => 42);
    expect(result).toBe(42);
  });

  it("supports synchronous returns", async () => {
    const result = await withSpan("test.sync", () => "hello");
    expect(result).toBe("hello");
  });

  it("emits a span with the supplied name", async () => {
    await withSpan("test.naming", async () => undefined);
    expect(finished()).toHaveLength(1);
    expect(finished()[0].name).toBe("test.naming");
  });

  it("sets attributes on the span before the function runs", async () => {
    await withSpan("test.attrs", () => undefined, { "user.id": "u-1", "tenant.id": "t-9" });
    const span = finished()[0];
    expect(span.attributes).toMatchObject({ "user.id": "u-1", "tenant.id": "t-9" });
  });

  it("sets OK status on success and ends the span", async () => {
    await withSpan("test.ok", () => "done");
    const span = finished()[0];
    expect(span.status.code).toBe(1); // SpanStatusCode.OK
    expect(span.endTime[0]).toBeGreaterThan(0);
  });

  it("re-throws errors from the inner function", async () => {
    await expect(
      withSpan("test.fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("records exception and sets ERROR status on throw, then ends the span", async () => {
    const err = new Error("fail");
    await expect(
      withSpan("test.err", () => {
        throw err;
      }),
    ).rejects.toBe(err);

    const span = finished()[0];
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.status.message).toBe("fail");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
    expect(span.endTime[0]).toBeGreaterThan(0);
  });

  it("normalizes non-Error throws into a string status message", async () => {
    await expect(
      withSpan("test.string-err", () => {
        throw "string-error";
      }),
    ).rejects.toBe("string-error");

    const span = finished()[0];
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe("string-error");
    // recordException is only called for Error instances; no exception event expected.
    expect(span.events.some((e) => e.name === "exception")).toBe(false);
  });
});
