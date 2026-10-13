import {
  type AnyOperation,
  defineApp,
  defineModule,
  defineOperation,
  operationError,
  operationFailure,
  permission,
  publicAccess,
} from "@sixthsummit/ship-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHonoAdapter } from "./adapter.js";
import { encodeSseEvent, encodeSseHeartbeat, STREAM_ERROR_CODES } from "./stream.js";
import {
  http,
  InvalidHttpTransportError,
  isHttpStreamTransport,
  isHttpTransport,
} from "./transport.js";

const frameSchema = z.object({ step: z.number().int(), note: z.string().trim() });
const terminalSchema = z.object({ steps: z.number().int() });
const fixtureFailed = operationError({
  code: "FIXTURE_FAILED",
  status: 409,
  message: "Fixture failed",
  details: z.object({ step: z.number() }),
});

interface StreamPlan {
  readonly frames: number;
  readonly failAt?: number;
  readonly throwAt?: number;
  readonly delayMs?: number;
  readonly badFrameAt?: number;
}

function streamTransport(
  limits: { heartbeatMs?: number; maxDurationMs?: number; maxFrames?: number } = {},
) {
  return http.post("/streams/:streamId", {
    response: {
      mode: "stream",
      framing: "sse",
      frame: frameSchema,
      heartbeatMs: limits.heartbeatMs ?? 1000,
      maxDurationMs: limits.maxDurationMs ?? 5000,
      maxFrames: limits.maxFrames ?? 100,
    },
  });
}

function streamOperation(
  limits: Parameters<typeof streamTransport>[0] = {},
  hooks: {
    readonly onSignal?: (signal: AbortSignal) => void;
    readonly onEmitError?: (error: unknown) => void;
    readonly onSettled?: () => void;
  } = {},
) {
  return defineOperation({
    id: "fixtures.stream",
    transport: streamTransport(limits),
    input: {
      params: z.object({ streamId: z.string() }),
      body: z.object({
        frames: z.number().int().min(0),
        failAt: z.number().int().optional(),
        throwAt: z.number().int().optional(),
        delayMs: z.number().int().optional(),
        badFrameAt: z.number().int().optional(),
      }),
    },
    output: { 200: terminalSchema },
    successStatus: 200,
    errors: [fixtureFailed],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: async ({ input, stream }) => {
      const plan: StreamPlan = input.body;
      hooks.onSignal?.(stream.signal);
      try {
        for (let step = 1; step <= plan.frames; step += 1) {
          if (plan.failAt === step) {
            throw operationFailure(fixtureFailed, { details: { step } });
          }
          if (plan.throwAt === step) throw new Error("handler exploded");
          if (plan.delayMs) await sleep(plan.delayMs);
          if (stream.signal.aborted) break;
          try {
            await stream.emit(
              plan.badFrameAt === step
                ? ({ step: "bad", note: "x" } as unknown as { step: number; note: string })
                : { step, note: ` note ${step} ` },
            );
          } catch (error) {
            hooks.onEmitError?.(error);
            throw error;
          }
        }
        return { steps: plan.frames };
      } finally {
        hooks.onSettled?.();
      }
    },
  });
}

function fixtureApp(operation: AnyOperation) {
  return defineApp({
    id: "fixture-api",
    modules: [
      defineModule({
        id: "fixtures",
        operations: [operation],
        providers: [],
        imports: [],
        exports: [],
      }),
    ],
  });
}

function request(
  app: ReturnType<typeof createHonoAdapter>,
  plan: StreamPlan,
  init: { readonly signal?: AbortSignal; readonly requestId?: string } = {},
) {
  return app.request("/streams/alpha", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": init.requestId ?? "stream-request",
      accept: "text/event-stream",
    },
    body: JSON.stringify(plan),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

interface ParsedEvent {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comments: readonly string[];
}

function parseSse(text: string): ParsedEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const parsed: { id?: string; event?: string; data?: string; comments: string[] } = {
        comments: [],
      };
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          parsed.comments.push(line);
          continue;
        }
        const separator = line.indexOf(":");
        const field = line.slice(0, separator);
        const value = line.slice(separator + 1).replace(/^ /u, "");
        if (field === "id") parsed.id = value;
        if (field === "event") parsed.event = value;
        if (field === "data")
          parsed.data = parsed.data === undefined ? value : `${parsed.data}\n${value}`;
      }
      return parsed;
    });
}

async function readAll(response: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("stream transport declarations", () => {
  it("projects stream metadata with a fixed content type", () => {
    const transport = streamTransport({ heartbeatMs: 10, maxDurationMs: 20, maxFrames: 3 });
    expect(transport.metadata).toEqual({
      method: "POST",
      path: "/streams/:streamId",
      response: "stream",
      contentType: "text/event-stream; charset=utf-8",
      requestBody: { mode: "json" },
    });
    expect(transport.response).toEqual({
      mode: "stream",
      framing: "sse",
      frame: frameSchema,
      heartbeatMs: 10,
      maxDurationMs: 20,
      maxFrames: 3,
    });
    expect(isHttpTransport(transport)).toBe(true);
    expect(isHttpStreamTransport(transport)).toBe(true);
    expect(isHttpStreamTransport(http.get("/plain"))).toBe(false);
  });

  it("rejects content-type overrides and inconsistent stream metadata", () => {
    expect(() =>
      http.get("/streams", {
        response: { mode: "stream", framing: "sse", frame: frameSchema },
        contentType: "text/plain",
      }),
    ).toThrow(InvalidHttpTransportError);
    expect(() =>
      http.get("/streams", {
        response: { mode: "stream", framing: "ndjson", frame: frameSchema } as never,
      }),
    ).toThrow(InvalidHttpTransportError);
    const transport = streamTransport();
    expect(isHttpTransport({ ...transport, response: undefined })).toBe(false);
    expect(isHttpTransport({ ...http.get("/plain"), response: transport.response })).toBe(false);
  });
});

describe("stream execution over HTTP", () => {
  it("emits id/event/data frames, a terminal event, and stream headers", async () => {
    const app = createHonoAdapter(fixtureApp(streamOperation()));
    const response = await request(app, { frames: 2 });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-ship-stream")).toBe("sse/1");
    expect(response.headers.get("x-request-id")).toBe("stream-request");
    expect(await readAll(response)).toBe(
      [
        encodeSseEvent({ id: 1, event: "frame", data: { step: 1, note: "note 1" } }),
        encodeSseEvent({ id: 2, event: "frame", data: { step: 2, note: "note 2" } }),
        encodeSseEvent({ id: 3, event: "terminal", data: { steps: 2 } }),
      ].join(""),
    );
  });

  it("opens the stream with only a terminal event when no frame is emitted", async () => {
    const app = createHonoAdapter(fixtureApp(streamOperation()));
    const response = await request(app, { frames: 0 });
    expect(response.status).toBe(200);
    expect(parseSse(await readAll(response))).toEqual([
      { id: "1", event: "terminal", data: JSON.stringify({ steps: 0 }), comments: [] },
    ]);
  });

  it("returns the unary error envelope when a declared error precedes the first frame", async () => {
    const app = createHonoAdapter(fixtureApp(streamOperation()));
    const response = await request(app, { frames: 3, failAt: 1 });
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "FIXTURE_FAILED", message: "Fixture failed", details: { step: 1 } },
    });
  });

  it("delivers a declared error after the first frame as a terminal error event", async () => {
    const app = createHonoAdapter(fixtureApp(streamOperation()));
    const response = await request(app, { frames: 3, failAt: 2 });
    expect(response.status).toBe(200);
    const events = parseSse(await readAll(response));
    expect(events.map((event) => event.event)).toEqual(["frame", "error"]);
    expect(JSON.parse(events[1].data ?? "")).toEqual({
      code: "FIXTURE_FAILED",
      status: 409,
      message: "Fixture failed",
      details: { step: 2 },
    });
  });

  it("hides unexpected failures behind INTERNAL_ERROR and notifies the observer", async () => {
    const onUnexpectedError = vi.fn();
    const app = createHonoAdapter(fixtureApp(streamOperation()), { onUnexpectedError });
    const afterFrame = await request(app, { frames: 3, throwAt: 2 });
    const events = parseSse(await readAll(afterFrame));
    expect(events.map((event) => event.event)).toEqual(["frame", "error"]);
    expect(JSON.parse(events[1].data ?? "")).toEqual({ ...STREAM_ERROR_CODES.internal });

    const beforeFrame = await request(app, { frames: 3, throwAt: 1 });
    expect(beforeFrame.status).toBe(500);
    expect(await beforeFrame.json()).toEqual({
      success: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
    });
    expect(onUnexpectedError).toHaveBeenCalledTimes(2);
    expect(onUnexpectedError.mock.calls[0][1]).toMatchObject({ operationId: "fixtures.stream" });
  });

  it("treats invalid frames as unexpected failures without leaking issues", async () => {
    const onUnexpectedError = vi.fn();
    const app = createHonoAdapter(fixtureApp(streamOperation()), { onUnexpectedError });
    const response = await request(app, { frames: 2, badFrameAt: 2 });
    const events = parseSse(await readAll(response));
    expect(events.map((event) => event.event)).toEqual(["frame", "error"]);
    expect(JSON.parse(events[1].data ?? "")).toEqual({ ...STREAM_ERROR_CODES.internal });
    expect(onUnexpectedError.mock.calls[0][0]).toMatchObject({
      code: "SHIP_OPERATION_STREAM_FRAME_INVALID",
    });
  });

  it("terminates with STREAM_MAX_FRAMES_EXCEEDED and aborts the handler", async () => {
    let signal: AbortSignal | undefined;
    const emitErrors: unknown[] = [];
    const onUnexpectedError = vi.fn();
    const app = createHonoAdapter(
      fixtureApp(
        streamOperation(
          { maxFrames: 2 },
          {
            onSignal: (value) => {
              signal = value;
            },
            onEmitError: (error) => emitErrors.push(error),
          },
        ),
      ),
      { onUnexpectedError },
    );
    const response = await request(app, { frames: 5 });
    const events = parseSse(await readAll(response));
    expect(events.map((event) => [event.id, event.event])).toEqual([
      ["1", "frame"],
      ["2", "frame"],
      ["3", "error"],
    ]);
    expect(JSON.parse(events[2].data ?? "")).toEqual({ ...STREAM_ERROR_CODES.maxFrames });
    expect(signal?.aborted).toBe(true);
    expect(emitErrors[0]).toMatchObject({ code: "STREAM_MAX_FRAMES_EXCEEDED" });
    expect(onUnexpectedError).not.toHaveBeenCalled();
  });

  it("terminates with STREAM_MAX_DURATION_EXCEEDED after the first frame", async () => {
    let signal: AbortSignal | undefined;
    const app = createHonoAdapter(
      fixtureApp(
        streamOperation(
          { maxDurationMs: 40, heartbeatMs: 5 },
          {
            onSignal: (value) => {
              signal = value;
            },
          },
        ),
      ),
    );
    const response = await request(app, { frames: 10, delayMs: 15 });
    const events = parseSse(await readAll(response)).filter((event) => event.event);
    expect(events.at(-1)?.event).toBe("error");
    expect(JSON.parse(events.at(-1)?.data ?? "")).toEqual({ ...STREAM_ERROR_CODES.maxDuration });
    expect(events.length).toBeLessThan(10);
    expect(signal?.aborted).toBe(true);
  });

  it("returns a 504 envelope when the duration budget expires before the first frame", async () => {
    const app = createHonoAdapter(fixtureApp(streamOperation({ maxDurationMs: 20 })));
    const response = await request(app, { frames: 1, delayMs: 80 });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "STREAM_MAX_DURATION_EXCEEDED",
        message: "Stream exceeded its maximum duration",
      },
    });
  });

  it("writes heartbeat comments while the handler is idle", async () => {
    const app = createHonoAdapter(fixtureApp(streamOperation({ heartbeatMs: 10 })));
    const response = await request(app, { frames: 2, delayMs: 45 });
    const text = await readAll(response);
    const heartbeats = text.match(/: hb \d+\n\n/gu) ?? [];
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[0]).toBe(encodeSseHeartbeat(Number(heartbeats[0].slice(5, -2))));
    expect(
      parseSse(text)
        .filter((event) => event.event)
        .map((event) => event.event),
    ).toEqual(["frame", "frame", "terminal"]);
  });

  it("aborts the handler when the reader cancels and releases within one heartbeat", async () => {
    let signal: AbortSignal | undefined;
    let settledAt: number | undefined;
    const emitErrors: unknown[] = [];
    const heartbeatMs = 50;
    const app = createHonoAdapter(
      fixtureApp(
        streamOperation(
          { heartbeatMs },
          {
            onSignal: (value) => {
              signal = value;
            },
            onEmitError: (error) => emitErrors.push(error),
            onSettled: () => {
              settledAt = Date.now();
            },
          },
        ),
      ),
    );
    const response = await request(app, { frames: 50, delayMs: 5 });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const cancelledAt = Date.now();
    await reader.cancel();
    await vi.waitFor(() => expect(settledAt).toBeDefined());
    expect(signal?.aborted).toBe(true);
    expect((settledAt as number) - cancelledAt).toBeLessThan(heartbeatMs);
    expect(emitErrors.length).toBeLessThanOrEqual(1);
  });

  it("aborts the handler when the request signal fires", async () => {
    let signal: AbortSignal | undefined;
    let settled = false;
    const controller = new AbortController();
    const app = createHonoAdapter(
      fixtureApp(
        streamOperation(
          {},
          {
            onSignal: (value) => {
              signal = value;
            },
            onSettled: () => {
              settled = true;
            },
          },
        ),
      ),
    );
    const response = await request(app, { frames: 50, delayMs: 5 }, { signal: controller.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort(new Error("navigated away"));
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ message: "navigated away" });
  });

  it("applies backpressure so a slow reader bounds the handler", async () => {
    let emitted = 0;
    const operation = defineOperation({
      id: "fixtures.stream",
      transport: streamTransport(),
      input: { params: z.object({ streamId: z.string() }) },
      output: { 200: z.object({ steps: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: async ({ stream }) => {
        for (let step = 1; step <= 6; step += 1) {
          emitted = step;
          await stream.emit({ step, note: `n${step}` });
        }
        return { steps: 6 };
      },
    });
    const app = createHonoAdapter(fixtureApp(operation));
    const response = await app.request("/streams/slow", { method: "POST" });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let reads = 0;
    while (true) {
      await sleep(10);
      const { done } = await reader.read();
      if (done) break;
      reads += 1;
      expect(emitted).toBeLessThanOrEqual(reads + 1);
    }
    expect(reads).toBe(7);
    expect(emitted).toBe(6);
  });

  it("runs authentication and access before opening a stream", async () => {
    const operation = defineOperation({
      id: "fixtures.stream",
      transport: streamTransport(),
      input: { params: z.object({ streamId: z.string() }) },
      output: { 200: z.object({ steps: z.number() }) },
      successStatus: 200,
      errors: [],
      access: permission("streams:read"),
      transaction: "none",
      dependencies: {},
      handler: () => ({ steps: 0 }),
    });
    const response = await createHonoAdapter(fixtureApp(operation)).request("/streams/secure", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTHENTICATION_ERROR" } });
  });
});

describe("SSE encoders", () => {
  it("encodes null for undefined terminal values and rejects unserializable data", () => {
    expect(encodeSseEvent({ id: 4, event: "terminal", data: undefined })).toBe(
      "id: 4\nevent: terminal\ndata: null\n\n",
    );
    expect(() => encodeSseEvent({ id: 1, event: "frame", data: () => undefined })).toThrow(
      TypeError,
    );
  });
});
