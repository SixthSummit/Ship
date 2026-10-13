import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { publicAccess } from "./access.js";
import {
  ApplicationCompilationError,
  type CompiledApplication,
  compileApp,
  defineApp,
} from "./application.js";
import { type CacheBackend, cacheBackendDependency } from "./cache.js";
import { createExecutor, OperationExecutionError } from "./executor.js";
import { type IdempotencyStore, idempotencyStoreDependency } from "./idempotency.js";
import { type AnyModule, defineModule } from "./module.js";
import {
  type AnyOperation,
  defineOperation,
  InvalidOperationDefinitionError,
  isOperationStreamResponse,
  type OperationStreamResponse,
} from "./operation.js";
import { operationError, operationFailure } from "./operation-error.js";
import { type AnyProvider, valueProvider } from "./provider.js";

const frameSchema = z.object({ index: z.number().int(), label: z.string().trim() });
const streamFailure = operationError({
  code: "STREAM_FIXTURE_FAILED",
  status: 409,
  message: "Stream fixture failed",
});

function streamResponse(
  overrides: Partial<OperationStreamResponse> = {},
): OperationStreamResponse<typeof frameSchema> {
  return {
    mode: "stream",
    framing: "sse",
    frame: frameSchema,
    heartbeatMs: 1000,
    maxDurationMs: 5000,
    maxFrames: 10,
    ...overrides,
  } as OperationStreamResponse<typeof frameSchema>;
}

function streamOperation(
  overrides: Partial<Parameters<typeof defineOperation>[0]> = {},
  response: OperationStreamResponse = streamResponse(),
) {
  return defineOperation({
    id: "fixtures.stream",
    transport: { kind: "fixture", binding: "stream", response },
    input: { body: z.object({ count: z.number().int().min(0) }) },
    output: { 200: z.object({ emitted: z.number() }) },
    successStatus: 200,
    errors: [streamFailure],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: async ({ input, stream }) => {
      for (let index = 0; index < input.body.count; index += 1) {
        await stream.emit({ index, label: ` frame-${index} ` });
      }
      return { emitted: input.body.count };
    },
    ...overrides,
  } as Parameters<typeof defineOperation>[0]);
}

function createFakeCache(): CacheBackend & {
  readonly get: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
} {
  return {
    kind: "ship.cache-backend",
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    del: async () => undefined,
    delByTag: async () => undefined,
    health: async () => ({ ok: true }),
  };
}

function fixtureApp(operation: AnyOperation, providers: readonly AnyProvider[] = []) {
  return defineApp({
    id: "fixture-api",
    modules: [
      defineModule({
        id: "fixtures",
        operations: [operation],
        providers: [...providers],
        imports: [],
        exports: [],
      }),
    ],
  });
}

describe("stream response declarations", () => {
  it("freezes the declaration and exposes it on the operation transport", () => {
    const operation = streamOperation();
    expect(operation.transport?.response).toEqual(streamResponse());
    expect(Object.isFrozen(operation.transport?.response)).toBe(true);
    expect(isOperationStreamResponse(operation.transport?.response)).toBe(true);
  });

  it.each([
    ["mode", { mode: "chunked" }],
    ["framing", { framing: "SSE" }],
    ["frame", { frame: { parse: () => undefined } }],
    ["heartbeatMs", { heartbeatMs: 0 }],
    ["maxDurationMs", { maxDurationMs: 1.5 }],
    ["maxFrames", { maxFrames: -1 }],
    ["unknown key", { terminal: frameSchema }],
  ])("rejects an invalid %s at definition time", (_name, overrides) => {
    expect(() =>
      streamOperation({}, streamResponse(overrides as Partial<OperationStreamResponse>)),
    ).toThrow(
      expect.objectContaining({
        name: "InvalidOperationDefinitionError",
        code: "SHIP_OPERATION_TRANSPORT_INVALID",
        field: "transport.response",
      }) as InvalidOperationDefinitionError,
    );
  });

  it("reports missing limits, transactions, and output shape when compiling", () => {
    const operation = streamOperation(
      { transaction: "read", output: { 201: frameSchema }, successStatus: 201 },
      streamResponse({ heartbeatMs: undefined, maxDurationMs: undefined, maxFrames: undefined }),
    );
    let error: unknown;
    try {
      compileApp({
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
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApplicationCompilationError);
    const diagnostics = (error as ApplicationCompilationError).diagnostics;
    expect(diagnostics.map((item) => [item.code, item.path])).toEqual([
      ["SHIP_OPERATION_STREAM_LIMIT_MISSING", "transport.response.heartbeatMs"],
      ["SHIP_OPERATION_STREAM_LIMIT_MISSING", "transport.response.maxDurationMs"],
      ["SHIP_OPERATION_STREAM_LIMIT_MISSING", "transport.response.maxFrames"],
      ["SHIP_OPERATION_STREAM_OUTPUT_INVALID", "output"],
      ["SHIP_OPERATION_STREAM_TRANSACTION_FORBIDDEN", "transaction"],
      ["SHIP_OPERATION_UNIT_OF_WORK_REQUIRED", "transaction"],
    ]);
    expect(diagnostics.every((item) => item.operationId === "fixtures.stream")).toBe(true);
  });

  it("rejects an idempotency declaration on a streaming operation when present", () => {
    // A fully resolvable declaration isolates the stream diagnostic from
    // dependency-resolution diagnostics.
    const storeToken = idempotencyStoreDependency("platform.idempotency");
    const store: IdempotencyStore = {
      kind: "ship.idempotency-store",
      claim: async () => "claimed",
      complete: async () => undefined,
      release: async () => undefined,
      readResult: async () => undefined,
    };
    const operation = {
      ...streamOperation(),
      idempotency: { key: () => "k", windowMs: 60_000, store: storeToken },
    } as AnyOperation;
    expect(() => fixtureApp(operation, [valueProvider(storeToken, store)])).toThrow(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: "SHIP_OPERATION_STREAM_IDEMPOTENCY_FORBIDDEN",
            path: "idempotency",
          }),
        ],
      }) as ApplicationCompilationError,
    );
  });

  it("rejects a read cache declaration on a streaming operation", () => {
    // Streams bypass the read cache: a frame sequence can never be stored or
    // replayed, so declaring one is a contradiction the graph reports.
    const cacheToken = cacheBackendDependency("platform.cache");
    const operation = {
      ...streamOperation({ dependencies: { cache: cacheToken } }),
      cache: { ttlMs: 60_000, scope: "public" },
    } as AnyOperation;
    expect(() => fixtureApp(operation, [valueProvider(cacheToken, createFakeCache())])).toThrow(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: "SHIP_OPERATION_STREAM_CACHE_FORBIDDEN",
            path: "cache",
          }),
        ],
      }) as ApplicationCompilationError,
    );
  });

  it("projects the stream declaration into the graph without schemas", () => {
    const node = fixtureApp(streamOperation()).graph.operations[0];
    expect(node.transport).toEqual({
      kind: "fixture",
      binding: "stream",
      response: {
        mode: "stream",
        framing: "sse",
        frame: { vendor: "zod" },
        heartbeatMs: 1000,
        maxDurationMs: 5000,
        maxFrames: 10,
      },
    });
    expect(JSON.parse(JSON.stringify(node.transport))).toEqual(node.transport);
  });
});

describe("stream execution", () => {
  it("validates frames before writing them to the sink and returns the terminal value", async () => {
    const written: unknown[] = [];
    const sink = { write: vi.fn(async (frame: unknown) => void written.push(frame)) };
    const result = await createExecutor(fixtureApp(streamOperation())).run(
      "fixtures.stream",
      { body: { count: 2 } },
      { requestId: "stream-1", stream: sink },
    );

    expect(result).toEqual({ ok: true, status: 200, data: { emitted: 2 }, requestId: "stream-1" });
    expect(written).toEqual([
      { index: 0, label: "frame-0" },
      { index: 1, label: "frame-1" },
    ]);
  });

  it("requires a sink for streaming operations and rejects sinks elsewhere", async () => {
    const executor = createExecutor(fixtureApp(streamOperation()));
    await expect(executor.run("fixtures.stream", { body: { count: 0 } })).rejects.toMatchObject({
      code: "SHIP_OPERATION_STREAM_SINK_MISSING",
    });

    const unary = defineOperation({
      id: "fixtures.unary",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => ({ ok: true as const }),
    });
    await expect(
      createExecutor(fixtureApp(unary)).run("fixtures.unary", {}, { stream: { write: () => {} } }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_CONTEXT_INVALID" });
  });

  it("fails the run when a handler emits an invalid frame", async () => {
    const operation = streamOperation({
      handler: async ({ stream }: { stream: { emit: (frame: unknown) => Promise<void> } }) => {
        await stream.emit({ index: "zero", label: "bad" });
        return { emitted: 1 };
      },
    });
    const sink = { write: vi.fn() };
    await expect(
      createExecutor(fixtureApp(operation)).run(
        "fixtures.stream",
        { body: { count: 0 } },
        { stream: sink },
      ),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_STREAM_FRAME_INVALID",
      issues: [expect.objectContaining({ path: ["index"] })],
    });
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("wraps a throwing frame schema", async () => {
    const throwingFrame = {
      "~standard": {
        version: 1 as const,
        vendor: "fixture",
        validate: () => {
          throw new Error("schema exploded");
        },
      },
    };
    const operation = streamOperation({}, streamResponse({ frame: throwingFrame }));
    await expect(
      createExecutor(fixtureApp(operation)).run(
        "fixtures.stream",
        { body: { count: 1 } },
        { stream: { write: () => {} } },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_STREAM_FRAME_SCHEMA_FAILED" });
  });

  it("rejects frames emitted after the handler returned", async () => {
    let escaped: ((frame: unknown) => Promise<void>) | undefined;
    const operation = streamOperation({
      handler: ({ stream }: { stream: { emit: (frame: unknown) => Promise<void> } }) => {
        escaped = stream.emit;
        return { emitted: 0 };
      },
    });
    await createExecutor(fixtureApp(operation)).run(
      "fixtures.stream",
      { body: { count: 0 } },
      { stream: { write: () => {} } },
    );
    await expect(escaped?.({ index: 0, label: "late" })).rejects.toMatchObject({
      code: "SHIP_OPERATION_STREAM_CLOSED",
    });
  });

  it("exposes the run signal to the handler and propagates sink rejections", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const operation = streamOperation({
      handler: async ({
        stream,
      }: {
        stream: { emit: (frame: unknown) => Promise<void>; signal: AbortSignal };
      }) => {
        observed = stream.signal;
        await stream.emit({ index: 0, label: "first" });
        return { emitted: 1 };
      },
    });
    const sink = {
      write: async () => {
        controller.abort(new Error("client left"));
        throw new Error("sink closed");
      },
    };
    await expect(
      createExecutor(fixtureApp(operation)).run(
        "fixtures.stream",
        { body: { count: 0 } },
        { stream: sink, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_HANDLER_FAILED" });
    expect(observed).toBe(controller.signal);
    expect(observed?.aborted).toBe(true);
  });

  it("gives the handler a never-aborted signal when the caller supplies none", async () => {
    let observed: AbortSignal | undefined;
    const operation = streamOperation({
      handler: ({ stream }: { stream: { signal: AbortSignal } }) => {
        observed = stream.signal;
        return { emitted: 0 };
      },
    });
    await createExecutor(fixtureApp(operation)).run(
      "fixtures.stream",
      { body: { count: 0 } },
      { stream: { write: () => {} } },
    );
    expect(observed?.aborted).toBe(false);
  });

  it("normalizes declared failures raised mid-stream into failure results", async () => {
    const operation = streamOperation({
      handler: async ({ stream }: { stream: { emit: (frame: unknown) => Promise<void> } }) => {
        await stream.emit({ index: 0, label: "first" });
        throw operationFailure(streamFailure);
      },
    });
    const written: unknown[] = [];
    const result = await createExecutor(fixtureApp(operation)).run(
      "fixtures.stream",
      { body: { count: 0 } },
      { requestId: "stream-2", stream: { write: (frame) => void written.push(frame) } },
    );
    expect(written).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "STREAM_FIXTURE_FAILED" },
    });
  });

  it("never reads or stores a streamed result even when a cache declaration bypassed compilation", async () => {
    // compileApp rejects the combination; this guards the executor for a graph
    // assembled without it, so frames are always produced by the handler.
    const cacheToken = cacheBackendDependency("platform.cache");
    const backend = createFakeCache();
    const handler = vi.fn(
      async ({
        input,
        stream,
      }: {
        input: { body: { count: number } };
        stream: { emit: (frame: unknown) => Promise<void> };
      }) => {
        for (let index = 0; index < input.body.count; index += 1) {
          await stream.emit({ index, label: `frame-${index}` });
        }
        return { emitted: input.body.count };
      },
    );
    const compiled = fixtureApp(streamOperation({ dependencies: { cache: cacheToken }, handler }), [
      valueProvider(cacheToken, backend),
    ]);
    const cached = {
      ...compiled.operationById["fixtures.stream"],
      cache: { ttlMs: 60_000, scope: "public" },
    };
    const app = {
      ...compiled,
      operationById: { "fixtures.stream": cached },
    } as unknown as CompiledApplication<string, readonly AnyModule[]>;
    const executor = createExecutor(app);
    const frames: unknown[] = [];
    const sink = { write: (frame: unknown) => void frames.push(frame) };

    const first = await executor.run("fixtures.stream", { body: { count: 2 } }, { stream: sink });
    const second = await executor.run("fixtures.stream", { body: { count: 2 } }, { stream: sink });

    expect(first).toEqual({
      ok: true,
      status: 200,
      data: { emitted: 2 },
      requestId: expect.any(String),
    });
    expect(second).not.toHaveProperty("cache");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(4);
    expect(backend.get).not.toHaveBeenCalled();
    expect(backend.set).not.toHaveBeenCalled();
  });

  it("validates the terminal value against the 200 output", async () => {
    const operation = streamOperation({ handler: () => ({ emitted: "many" }) });
    await expect(
      createExecutor(fixtureApp(operation)).run(
        "fixtures.stream",
        { body: { count: 0 } },
        { stream: { write: () => {} } },
      ),
    ).rejects.toBeInstanceOf(OperationExecutionError);
  });
});
