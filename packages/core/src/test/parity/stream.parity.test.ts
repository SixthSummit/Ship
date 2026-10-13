import {
  defineApp,
  defineModule,
  defineOperation,
  operationError,
  operationFailure,
  publicAccess,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, encodeSseEvent, http } from "@sixthsummit/ship-hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { streamSSE } from "../../http/streaming/sse.js";

/**
 * Compatibility parity: a route-first app writing the documented Ship SSE
 * layout through the compatibility `streamSSE` helper must produce the same
 * bytes as a kernel `stream` operation emitting the same frame sequence, so a
 * consumer can migrate a stream route without changing its browser client.
 */

const frames = [
  { step: 1, note: "one" },
  { step: 2, note: "two" },
  { step: 3, note: "three" },
];
const terminal = { steps: 3 };
const failure = { code: "STEP_FAILED", status: 409, message: "Step failed", details: { step: 2 } };

function kernelApp(failAt?: number) {
  const stepFailed = operationError({
    code: "STEP_FAILED",
    status: 409,
    message: "Step failed",
    details: z.object({ step: z.number() }),
  });
  const operation = defineOperation({
    id: "steps.stream",
    transport: http.get("/steps", {
      response: {
        mode: "stream",
        framing: "sse",
        frame: z.object({ step: z.number(), note: z.string() }),
        heartbeatMs: 10_000,
        maxDurationMs: 10_000,
        maxFrames: 10,
      },
    }),
    input: {},
    output: { 200: z.object({ steps: z.number() }) },
    successStatus: 200,
    errors: [stepFailed],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: async ({ stream }) => {
      for (const frame of frames) {
        if (failAt === frame.step) {
          throw operationFailure(stepFailed, { details: { step: frame.step } });
        }
        await stream.emit(frame);
      }
      return terminal;
    },
  });
  return createHonoAdapter(
    defineApp({
      id: "parity",
      modules: [
        defineModule({
          id: "steps",
          operations: [operation],
          providers: [],
          imports: [],
          exports: [],
        }),
      ],
    }),
  );
}

function compatApp(failAt?: number) {
  const app = new Hono();
  app.get("/steps", (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      for (const frame of frames) {
        if (failAt === frame.step) {
          await stream.write(encodeSseEvent({ id: id + 1, event: "error", data: failure }));
          return;
        }
        id += 1;
        await stream.write(encodeSseEvent({ id, event: "frame", data: frame }));
      }
      await stream.write(encodeSseEvent({ id: id + 1, event: "terminal", data: terminal }));
    }),
  );
  return app;
}

async function bytes(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/u);
  return new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
}

describe("stream response parity (compat streamSSE vs kernel stream mode)", () => {
  it("produces byte-identical SSE for the same frame sequence and terminal", async () => {
    const kernel = await bytes(await kernelApp().request("/steps"));
    const compat = await bytes(await compatApp().request("/steps"));
    expect(kernel).toBe(compat);
    expect(kernel).toBe(
      [
        'id: 1\nevent: frame\ndata: {"step":1,"note":"one"}\n\n',
        'id: 2\nevent: frame\ndata: {"step":2,"note":"two"}\n\n',
        'id: 3\nevent: frame\ndata: {"step":3,"note":"three"}\n\n',
        'id: 4\nevent: terminal\ndata: {"steps":3}\n\n',
      ].join(""),
    );
  });

  it("produces byte-identical SSE for a declared error after the first frame", async () => {
    const kernel = await bytes(await kernelApp(2).request("/steps"));
    const compat = await bytes(await compatApp(2).request("/steps"));
    expect(kernel).toBe(compat);
    expect(kernel).toContain(
      'id: 2\nevent: error\ndata: {"code":"STEP_FAILED","status":409,"message":"Step failed","details":{"step":2}}\n\n',
    );
  });
});
