import {
  defineApp,
  defineModule,
  defineOperation,
  operationError,
  operationFailure,
  publicAccess,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApplicationContractOf } from "./application.js";
import { createHttpOperationClient, OperationClientError } from "./client.js";
import { projectOpenApi } from "./openapi.js";
import { projectClientContract } from "./project.js";
import { contractSchema } from "./schema.js";
import { STREAM_INTERRUPTED } from "./stream.js";

const tickFailed = operationError({
  code: "TICK_FAILED",
  status: 409,
  message: "Tick failed",
  details: z.object({ tick: z.number() }),
});
const frameSchema = contractSchema(z.object({ tick: z.number().int(), at: z.date() }), {
  jsonSchema: {
    type: "object",
    required: ["tick", "at"],
    properties: { tick: { type: "integer" }, at: { type: "string", format: "date-time" } },
  },
  codec: "clock.frame",
});
const terminalSchema = z.object({ ticks: z.number().int() });

const ticker = defineOperation({
  id: "clock.ticks",
  transport: http.post("/clock/ticks", {
    response: {
      mode: "stream",
      framing: "sse",
      frame: frameSchema,
      heartbeatMs: 1000,
      maxDurationMs: 5000,
      maxFrames: 50,
    },
  }),
  input: {
    body: z.object({
      ticks: z.number().int().min(0),
      failAt: z.number().int().optional(),
      throwAt: z.number().int().optional(),
    }),
  },
  output: { 200: terminalSchema },
  successStatus: 200,
  errors: [tickFailed],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: async ({ input, stream }) => {
    for (let tick = 1; tick <= input.body.ticks; tick += 1) {
      if (input.body.failAt === tick) throw operationFailure(tickFailed, { details: { tick } });
      if (input.body.throwAt === tick) throw new Error("boom");
      await stream.emit({ tick, at: new Date(Date.UTC(2026, 8, 18, 0, 0, tick)) });
    }
    return { ticks: input.body.ticks };
  },
});
const readClock = defineOperation({
  id: "clock.read",
  transport: http.get("/clock"),
  input: {},
  output: { 200: z.object({ now: z.string() }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: () => ({ now: "2026-09-18T00:00:00.000Z" }),
});
const application = defineApp({
  id: "clock-api",
  modules: [
    defineModule({
      id: "clock",
      operations: [ticker, readClock],
      providers: [],
      imports: [],
      exports: [],
    }),
  ],
});
const contract = projectClientContract(application);
type Contract = ApplicationContractOf<typeof application>;

function fixtureClient(
  fetch: typeof globalThis.fetch = (input, init) => hono.request(input, init),
) {
  return createHttpOperationClient<Contract>(contract, {
    baseUrl: "https://clock.example.test",
    fetch,
    codecs: { "clock.frame": { decode: (value) => decodeFrame(value) } },
  });
}
const hono = createHonoAdapter(application);

function decodeFrame(value: unknown): { tick: number; at: Date } {
  const record = value as { tick: number; at: string };
  return { tick: record.tick, at: new Date(record.at) };
}

async function collect<TValue>(iterable: AsyncIterable<TValue>): Promise<TValue[]> {
  const values: TValue[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("stream contract projection", () => {
  it("marks streaming operations with a fingerprinted response declaration", () => {
    const operation = contract.operations.find((item) => item.id === "clock.ticks");
    expect(operation?.transport?.metadata).toMatchObject({
      response: "stream",
      contentType: "text/event-stream; charset=utf-8",
    });
    expect(operation?.response).toEqual({
      mode: "stream",
      framing: "sse",
      frame: {
        vendor: "zod",
        codec: "clock.frame",
        jsonSchema: {
          type: "object",
          required: ["tick", "at"],
          properties: { tick: { type: "integer" }, at: { type: "string", format: "date-time" } },
        },
      },
      terminal: operation?.success[0] && {
        vendor: "zod",
        jsonSchema: operation.success[0].jsonSchema,
      },
      limits: { heartbeatMs: 1000, maxDurationMs: 5000, maxFrames: 50 },
    });
    expect(contract.operations.find((item) => item.id === "clock.read")?.response).toBeUndefined();

    const changedFrame = defineApp({
      id: "clock-api",
      modules: [
        defineModule({
          id: "clock",
          operations: [
            defineOperation({
              ...ticker,
              transport: http.post("/clock/ticks", {
                response: { ...ticker.transport.response, frame: z.object({ tick: z.string() }) },
              }),
            }),
            readClock,
          ],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    });
    expect(projectClientContract(changedFrame).fingerprint).not.toBe(contract.fingerprint);
  });

  it("projects the event stream response and extensions into OpenAPI", () => {
    const document = projectOpenApi(application, { title: "Clock", version: "1.0.0" });
    const operation = (document.paths as Record<string, Record<string, Record<string, unknown>>>)[
      "/clock/ticks"
    ].post;
    expect(operation.responses).toMatchObject({
      "200": {
        content: {
          "text/event-stream; charset=utf-8": {
            schema: { type: "string", format: "event-stream" },
          },
        },
        headers: { "X-Request-Id": { required: true }, "X-Ship-Stream": { required: true } },
        "x-ship-stream-framing": "sse",
        "x-ship-stream-frame": { type: "object" },
        "x-ship-stream-terminal": { type: "object" },
        "x-ship-stream-limits": { heartbeatMs: 1000, maxDurationMs: 5000, maxFrames: 50 },
      },
      "409": {},
    });
  });

  it("rejects manifests whose stream response and metadata disagree", () => {
    const [streamOperation] = contract.operations.filter((item) => item.id === "clock.ticks");
    const withoutResponse = { ...streamOperation, response: undefined };
    const invalidLimits = {
      ...streamOperation,
      response: { ...streamOperation.response, limits: { heartbeatMs: 0 } },
    };
    for (const operation of [withoutResponse, invalidLimits]) {
      expect(() =>
        createHttpOperationClient({ ...contract, operations: [operation] } as typeof contract, {
          baseUrl: "https://clock.example.test",
          fetch: () => Promise.reject(new Error()),
        }),
      ).toThrow(OperationClientError);
    }
  });
});

describe("stream client handle", () => {
  it("yields decoded frames and resolves the terminal value", async () => {
    const handle = fixtureClient().call("clock.ticks", { body: { ticks: 2 } });
    expect(handle.status).toBe("connecting");
    const frames = await collect(handle.frames);
    expect(frames).toEqual([
      { tick: 1, at: new Date("2026-09-18T00:00:01.000Z") },
      { tick: 2, at: new Date("2026-09-18T00:00:02.000Z") },
    ]);
    await expect(handle.terminal).resolves.toEqual({ ticks: 2 });
    expect(handle.status).toBe("closed");
    expect(handle.error).toBeUndefined();
    expect(handle.requestId).toEqual(expect.any(String));
    expect(handle.metadata?.headers["x-ship-stream"]).toBe("sse/1");
  });

  it("surfaces an error envelope sent before the first frame as a stream error", async () => {
    const handle = fixtureClient().call("clock.ticks", { body: { ticks: 3, failAt: 1 } });
    expect(await collect(handle.frames)).toEqual([]);
    await expect(handle.terminal).resolves.toBeUndefined();
    expect(handle.status).toBe("error");
    expect(handle.error).toEqual({
      code: "TICK_FAILED",
      status: 409,
      message: "Tick failed",
      details: { tick: 1 },
    });
  });

  it("surfaces a terminal error event after frames were delivered", async () => {
    const handle = fixtureClient().call("clock.ticks", { body: { ticks: 3, failAt: 3 } });
    expect((await collect(handle.frames)).map((frame) => frame.tick)).toEqual([1, 2]);
    await expect(handle.terminal).resolves.toBeUndefined();
    expect(handle.error).toEqual({
      code: "TICK_FAILED",
      status: 409,
      message: "Tick failed",
      details: { tick: 3 },
    });
    const unexpected = fixtureClient().call("clock.ticks", { body: { ticks: 3, throwAt: 2 } });
    await unexpected.terminal;
    expect(unexpected.error).toEqual({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "An unexpected error occurred",
    });
  });

  it("reports STREAM_INTERRUPTED when the connection closes without a final event", async () => {
    const fetch = vi.fn(
      async () =>
        new Response('id: 1\nevent: frame\ndata: {"tick":1,"at":"2026-09-18T00:00:01.000Z"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream", "x-request-id": "cut" },
        }),
    );
    const handle = fixtureClient(fetch as typeof globalThis.fetch).call("clock.ticks", {
      body: { ticks: 1 },
    });
    expect((await collect(handle.frames)).map((frame) => frame.tick)).toEqual([1]);
    await handle.terminal;
    expect(handle.status).toBe("error");
    expect(handle.error).toMatchObject({ code: STREAM_INTERRUPTED, status: 0 });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("accept")).toBe("text/event-stream");
  });

  it("reports STREAM_INTERRUPTED for network failures, non-stream bodies, and malformed events", async () => {
    const failing = fixtureClient(async () => {
      throw new TypeError("network down");
    });
    const dropped = failing.call("clock.ticks", { body: { ticks: 1 } });
    await dropped.terminal;
    expect(dropped.error).toEqual({ code: STREAM_INTERRUPTED, status: 0, message: "network down" });

    const html = fixtureClient(
      async () =>
        new Response("<html/>", { status: 502, headers: { "content-type": "text/html" } }),
    ).call("clock.ticks", { body: { ticks: 1 } });
    await html.terminal;
    expect(html.error?.code).toBe(STREAM_INTERRUPTED);

    const malformed = fixtureClient(
      async () =>
        new Response("id: 1\nevent: error\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ).call("clock.ticks", { body: { ticks: 1 } });
    await malformed.terminal;
    expect(malformed.error).toMatchObject({ code: STREAM_INTERRUPTED });
  });

  it("aborts the request and settles as aborted", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = fixtureClient((input, init) => {
      requestSignal = init?.signal ?? undefined;
      return hono.request(input, init);
    });
    const handle = client.call("clock.ticks", { body: { ticks: 40 } });
    const iterator = handle.frames[Symbol.asyncIterator]();
    await iterator.next();
    handle.abort();
    expect(handle.status).toBe("aborted");
    expect(requestSignal?.aborted).toBe(true);
    await expect(handle.terminal).resolves.toBeUndefined();
    const rest = await collect({ [Symbol.asyncIterator]: () => iterator });
    expect(rest.length).toBeLessThan(40);
    const external = new AbortController();
    external.abort();
    const preAborted = client.call(
      "clock.ticks",
      { body: { ticks: 1 } },
      { signal: external.signal },
    );
    expect(preAborted.status).toBe("aborted");
  });

  it("rejects the handle for client-side input and codec misuse", async () => {
    const handle = fixtureClient().call("clock.ticks", {
      body: { ticks: 1 },
      query: {},
    } as never);
    await expect(collect(handle.frames)).rejects.toMatchObject({
      code: "SHIP_CLIENT_INPUT_INVALID",
    });
    await expect(handle.terminal).rejects.toBeInstanceOf(OperationClientError);
    expect(handle.status).toBe("error");
    expect(handle.error).toMatchObject({ code: "SHIP_CLIENT_INPUT_INVALID", status: 0 });
  });

  it("keeps unary operations on the promise path", async () => {
    const result = await fixtureClient().call("clock.read", {});
    expect(result).toMatchObject({ ok: true, status: 200, data: { now: expect.any(String) } });
  });
});
