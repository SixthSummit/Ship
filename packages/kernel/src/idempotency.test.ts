import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { publicAccess } from "./access.js";
import { ApplicationCompilationError, compileApp, defineApp } from "./application.js";
import { type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { createExecutor } from "./executor.js";
import {
  type IdempotencyContext,
  type IdempotencyStore,
  idempotencyStoreDependency,
  isIdempotencyStore,
  isIdempotencyStoreDependencyToken,
  isOperationIdempotency,
  isStoredIdempotentResult,
} from "./idempotency.js";
import { defineModule } from "./module.js";
import { defineOperation, InvalidOperationDefinitionError, respond } from "./operation.js";
import { operationError, operationFailure } from "./operation-error.js";
import { defineProvider, valueProvider } from "./provider.js";

const storeToken = idempotencyStoreDependency("platform.idempotency");
const unitOfWork = unitOfWorkDependency<{ readonly records: { save(value: string): void } }>(
  "database.primary",
);
const rejected = operationError({ code: "REJECTED", status: 422, message: "Rejected" });

/** Deterministic in-test store that records every call and its context. */
function fakeStore() {
  const entries = new Map<string, { status: "in-flight" | "completed"; result?: unknown }>();
  const calls: {
    readonly method: string;
    readonly key: string;
    readonly context: IdempotencyContext;
  }[] = [];
  const store: IdempotencyStore & {
    readonly entries: typeof entries;
    readonly calls: typeof calls;
  } = {
    kind: "ship.idempotency-store",
    entries,
    calls,
    claim: async (key, _ttlMs, context) => {
      calls.push({ method: "claim", key, context });
      const existing = entries.get(key);
      if (existing?.status === "completed") return "duplicate";
      if (existing?.status === "in-flight") return "in-flight";
      entries.set(key, { status: "in-flight" });
      return "claimed";
    },
    complete: async (key, result, context) => {
      calls.push({ method: "complete", key, context });
      entries.set(key, { status: "completed", result });
    },
    release: async (key, context) => {
      calls.push({ method: "release", key, context });
      entries.delete(key);
    },
    readResult: async (key, context) => {
      calls.push({ method: "readResult", key, context });
      return entries.get(key)?.result;
    },
  };
  return store;
}

function fixture(
  store: IdempotencyStore,
  options: {
    readonly handler?: (arguments_: {
      readonly input: { readonly body: { readonly key: string; readonly value: number } };
    }) => unknown;
    readonly transaction?: "none" | "write";
    readonly unitOfWork?: UnitOfWork<{ readonly records: { save(value: string): void } }>;
  } = {},
) {
  const transaction = options.transaction ?? "none";
  const operation = defineOperation({
    id: "payments.charge",
    input: { body: z.object({ key: z.string().min(1), value: z.number() }) },
    output: { 200: z.object({ value: z.number() }), 202: z.object({ queued: z.literal(true) }) },
    successStatus: 200,
    errors: [rejected],
    access: publicAccess(),
    transaction,
    dependencies: transaction === "write" ? { tx: unitOfWork } : {},
    idempotency: { key: (input) => input.body.key, windowMs: 60_000, store: storeToken },
    handler: (options.handler ?? (({ input }) => ({ value: input.body.value * 2 }))) as never,
  });
  const module = defineModule({
    id: "payments",
    operations: [operation],
    providers: [
      valueProvider(storeToken, store),
      ...(transaction === "write"
        ? [
            valueProvider(
              unitOfWork,
              options.unitOfWork ?? {
                kind: "ship.unit-of-work",
                id: "database.primary",
                run: async (_mode, work) => work({ records: { save: () => undefined } }),
              },
            ),
          ]
        : []),
    ],
    imports: [],
    exports: [],
  });
  const app = defineApp({ id: "payments-api", modules: [module] });
  return { app, operation, executor: createExecutor(app) };
}

describe("idempotency declarations", () => {
  it("creates frozen store tokens and validates declarations", () => {
    expect(storeToken).toEqual({
      kind: "ship.dependency",
      id: "platform.idempotency",
      scope: "idempotency",
    });
    expect(Object.isFrozen(storeToken)).toBe(true);
    expect(() => idempotencyStoreDependency("Bad Id")).toThrow(TypeError);
    expect(isIdempotencyStoreDependencyToken(storeToken)).toBe(true);
    expect(isIdempotencyStoreDependencyToken(unitOfWork)).toBe(false);
    expect(isIdempotencyStore(fakeStore())).toBe(true);
    expect(isIdempotencyStore({ kind: "ship.idempotency-store" })).toBe(false);
    expect(isOperationIdempotency({ key: () => "k", windowMs: 10, store: storeToken })).toBe(true);
    expect(isOperationIdempotency({ key: () => "k", windowMs: 0, store: storeToken })).toBe(false);
    expect(isOperationIdempotency({ key: "k", windowMs: 10, store: storeToken })).toBe(false);
    expect(isOperationIdempotency({ key: () => "k", windowMs: 10, store: unitOfWork })).toBe(false);
    expect(isStoredIdempotentResult({ status: 200, data: {} })).toBe(true);
    expect(isStoredIdempotentResult({ status: 200, data: null, dataUndefined: true })).toBe(true);
    expect(isStoredIdempotentResult({ status: 200, data: null, dataUndefined: false })).toBe(false);
    expect(isStoredIdempotentResult({ status: 200, data: {}, dataUndefined: true })).toBe(false);
    expect(isStoredIdempotentResult({ status: 200, data: {}, headers: { etag: "1" } })).toBe(true);
    expect(isStoredIdempotentResult({ status: 500, data: {} })).toBe(false);
    expect(isStoredIdempotentResult({ status: 200 })).toBe(false);
    expect(isStoredIdempotentResult({ status: 200, data: {}, headers: { etag: 1 } })).toBe(false);
    expect(isStoredIdempotentResult(null)).toBe(false);
  });

  it("rejects malformed declarations with a stable operation diagnostic", () => {
    expect(() =>
      defineOperation({
        id: "payments.charge",
        input: {},
        output: { 200: z.object({}) },
        successStatus: 200,
        errors: [],
        access: publicAccess(),
        transaction: "none",
        dependencies: {},
        idempotency: { key: () => "k", windowMs: 0, store: storeToken },
        handler: () => ({}),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "InvalidOperationDefinitionError",
        code: "SHIP_OPERATION_IDEMPOTENCY_INVALID",
      }),
    );
    expect(InvalidOperationDefinitionError).toBeDefined();
  });

  it("freezes the declaration and projects it into the graph", () => {
    const { app, operation } = fixture(fakeStore());

    expect(Object.isFrozen(operation.idempotency)).toBe(true);
    expect(app.graph.operations[0]).toMatchObject({
      idempotency: { windowMs: 60_000, storeId: "platform.idempotency" },
    });
    expect(app.graph.providers.find((node) => node.id === "platform.idempotency")).toMatchObject({
      scope: "idempotency",
    });
  });

  it("requires a singleton provider for the store token", () => {
    const operation = fixture(fakeStore()).operation;
    const module = defineModule({
      id: "payments",
      operations: [operation],
      providers: [
        defineProvider({
          token: storeToken,
          dependencies: {},
          lifetime: "operation",
          create: () => fakeStore(),
        }),
      ],
      imports: [],
      exports: [],
    });
    expect(() => compileApp({ id: "payments-api", modules: [module] })).toThrowError(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({ code: "SHIP_IDEMPOTENCY_PROVIDER_LIFETIME_INVALID" }),
        ],
      }),
    );

    const unbound = defineModule({
      id: "payments",
      operations: [operation],
      providers: [],
      imports: [],
      exports: [],
    });
    try {
      compileApp({ id: "payments-api", modules: [unbound] });
      throw new Error("expected compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCompilationError);
      expect((error as ApplicationCompilationError).diagnostics).toEqual([
        expect.objectContaining({
          code: "SHIP_PROVIDER_MISSING",
          operationId: "payments.charge",
          path: "idempotency.store",
        }),
      ]);
    }
  });
});

describe("executor idempotency enforcement", () => {
  it("runs once per key and replays the stored success result for duplicates", async () => {
    const store = fakeStore();
    const handler = vi.fn(({ input }: { readonly input: { readonly body: { value: number } } }) =>
      respond(202, { queued: true as const }, { headers: { "x-first": String(input.body.value) } }),
    );
    const { executor } = fixture(store, { handler });

    const first = await executor.run(
      "payments.charge",
      { body: { key: "order-1", value: 5 } },
      { requestId: "r1" },
    );
    const replay = await executor.run(
      "payments.charge",
      { body: { key: "order-1", value: 99 } },
      { requestId: "r2" },
    );

    expect(first).toEqual({
      ok: true,
      status: 202,
      data: { queued: true },
      headers: { "x-first": "5" },
      requestId: "r1",
    });
    expect(replay).toEqual({
      ok: true,
      status: 202,
      data: { queued: true },
      headers: { "x-first": "5" },
      requestId: "r2",
      replayed: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.calls.map((call) => call.method)).toEqual([
      "claim",
      "complete",
      "claim",
      "readResult",
    ]);
    expect(store.calls[0]).toMatchObject({ key: "payments.charge:order-1" });
    expect(store.calls[0]!.context.scope).toBeUndefined();
    expect(store.calls[0]!.context.now).toBeInstanceOf(Date);
  });

  it("reports an in-flight key with the stable IDEMPOTENT_IN_FLIGHT failure", async () => {
    const store = fakeStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { executor } = fixture(store, {
      handler: async ({ input }) => {
        await gate;
        return { value: input.body.value };
      },
    });

    const running = executor.run("payments.charge", { body: { key: "k", value: 1 } });
    await vi.waitFor(() => expect(store.entries.get("payments.charge:k")).toBeDefined());
    const concurrent = await executor.run(
      "payments.charge",
      { body: { key: "k", value: 2 } },
      { requestId: "r2" },
    );
    release();

    expect(concurrent).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "IDEMPOTENT_IN_FLIGHT",
        message: "An identical request is still in flight",
        details: { idempotencyKey: "payments.charge:k" },
      },
      requestId: "r2",
    });
    await expect(running).resolves.toMatchObject({ ok: true, data: { value: 1 } });
  });

  it.each([
    [
      "unexpected handler failure",
      () => {
        throw new Error("boom");
      },
      { code: "SHIP_OPERATION_HANDLER_FAILED" },
    ],
    [
      "declared failure",
      () => {
        throw operationFailure(rejected);
      },
      { ok: false, status: 422, error: { code: "REJECTED" } },
    ],
  ])("releases the claim after a %s so the key can be retried", async (_name, handler, expected) => {
    const store = fakeStore();
    const { executor } = fixture(store, { handler });

    const outcome = executor.run("payments.charge", { body: { key: "k", value: 1 } });
    if ("code" in expected) {
      await expect(outcome).rejects.toMatchObject(expected);
    } else {
      await expect(outcome).resolves.toMatchObject(expected);
    }
    expect(store.calls.map((call) => call.method)).toEqual(["claim", "release"]);
    expect(store.entries.size).toBe(0);
  });

  it("keeps the original failure when release itself fails", async () => {
    const store = fakeStore();
    store.release = async () => {
      throw new Error("store down");
    };
    const { executor } = fixture(store, {
      handler: () => {
        throw new Error("boom");
      },
    });

    await expect(
      executor.run("payments.charge", { body: { key: "k", value: 1 } }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_HANDLER_FAILED" });
  });

  it("passes the active unit-of-work scope to the store for transactional operations", async () => {
    const store = fakeStore();
    const capabilities = { records: { save: vi.fn() } };
    const controller: UnitOfWork<typeof capabilities> = {
      kind: "ship.unit-of-work",
      id: "database.primary",
      run: async (_mode, work) => work(capabilities),
    };
    const { executor } = fixture(store, { transaction: "write", unitOfWork: controller });

    await executor.run("payments.charge", { body: { key: "k", value: 3 } });

    expect(store.calls.map((call) => call.method)).toEqual(["claim", "complete"]);
    expect(store.calls[0]!.context.scope).toEqual(capabilities);
    expect(store.calls[1]!.context.scope).toEqual(capabilities);
  });

  it.each([
    ["an empty key", () => " ", "SHIP_OPERATION_IDEMPOTENCY_KEY_INVALID"],
    [
      "a throwing key function",
      () => {
        throw new Error("no key");
      },
      "SHIP_OPERATION_IDEMPOTENCY_KEY_INVALID",
    ],
  ])("rejects %s before claiming", async (_name, key, code) => {
    const store = fakeStore();
    const operation = defineOperation({
      id: "payments.charge",
      input: { body: z.object({ key: z.string() }) },
      output: { 200: z.object({}) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      idempotency: { key, windowMs: 1_000, store: storeToken },
      handler: () => ({}),
    });
    const module = defineModule({
      id: "payments",
      operations: [operation],
      providers: [valueProvider(storeToken, store)],
      imports: [],
      exports: [],
    });
    const executor = createExecutor(defineApp({ id: "payments-api", modules: [module] }));

    await expect(executor.run("payments.charge", { body: { key: "k" } })).rejects.toMatchObject({
      code,
    });
    expect(store.calls).toHaveLength(0);
  });

  it("rejects providers that do not create an idempotency store", async () => {
    const { executor } = fixture({ kind: "ship.idempotency-store" } as IdempotencyStore);

    await expect(
      executor.run("payments.charge", { body: { key: "k", value: 1 } }),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_IDEMPOTENCY_STORE_INVALID",
      providerId: "platform.idempotency",
    });
  });

  it("fails loudly when a completed key has no stored result", async () => {
    const store = fakeStore();
    store.entries.set("payments.charge:k", { status: "completed" });
    const { executor } = fixture(store);

    await expect(
      executor.run("payments.charge", { body: { key: "k", value: 1 } }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_IDEMPOTENCY_RESULT_MISSING" });
  });
});
