import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  anyPermission,
  authenticatedAccess,
  permission,
  providerAccess,
  publicAccess,
  systemAccess,
} from "./access.js";
import { operationActor, operationIdentity, providerActor, systemActor } from "./actor.js";
import { defineApp } from "./application.js";
import { dependency, type UnitOfWork, unitOfWorkDependency } from "./dependency.js";
import { createExecutor, OperationExecutionError, type OperationRunOptions } from "./executor.js";
import { defineModule } from "./module.js";
import {
  defineOperation,
  type OperationContext,
  type OperationTransactionDeclaration,
  respond,
} from "./operation.js";
import {
  type OperationErrorDefinition,
  OperationFailure,
  operationError,
  operationFailure,
} from "./operation-error.js";
import { defineProvider, type ProviderLifetime, valueProvider } from "./provider.js";
import type { RuntimeSchema } from "./schema.js";

interface FixtureService {
  multiply(value: number): number;
}

interface TransactionCapabilities {
  readonly records: {
    save(value: number): number;
  };
}

const serviceToken = dependency<FixtureService>("fixture.service");
const transactionToken = unitOfWorkDependency<TransactionCapabilities>("database.primary");
const notFound = operationError({
  code: "FIXTURE_NOT_FOUND",
  status: 404,
  message: "Fixture not found",
  details: z.object({ id: z.number().int() }),
});
const conflict = operationError({
  code: "FIXTURE_CONFLICT",
  status: 409,
  message: "Fixture already exists",
});

interface FixtureHandlerArguments {
  readonly input: { readonly params: { readonly id: number } };
  readonly services: { readonly fixture: FixtureService };
  readonly context: OperationContext;
}

function createFixture(
  options: {
    access?:
      | ReturnType<typeof publicAccess>
      | ReturnType<typeof authenticatedAccess>
      | ReturnType<typeof permission>
      | ReturnType<typeof systemAccess>
      | ReturnType<typeof providerAccess>;
    lifetime?: ProviderLifetime;
    createService?: () => FixtureService | Promise<FixtureService>;
    handler?: (arguments_: FixtureHandlerArguments) => unknown | Promise<unknown>;
    errors?: readonly OperationErrorDefinition[];
    inputSchema?: RuntimeSchema;
    outputSchema?: RuntimeSchema;
  } = {},
) {
  const createService = options.createService ?? (() => ({ multiply: (value) => value * 2 }));
  const serviceProvider = defineProvider({
    token: serviceToken,
    dependencies: {},
    lifetime: options.lifetime ?? "operation",
    create: createService,
  });
  const operation = defineOperation({
    id: "fixture.read",
    input: {
      params: options.inputSchema ?? z.object({ id: z.coerce.number().int().positive() }),
    },
    output: {
      200: options.outputSchema ?? z.object({ value: z.number() }),
      202: z.object({ queued: z.literal(true) }),
    },
    successStatus: 200,
    errors: options.errors ?? [notFound, conflict],
    access: options.access ?? publicAccess(),
    transaction: "none",
    dependencies: { fixture: serviceToken },
    handler: (options.handler ??
      (({ input, services }) => ({ value: services.fixture.multiply(input.params.id) }))) as never,
  });
  const module = defineModule({
    id: "fixture",
    operations: [operation],
    providers: [serviceProvider],
    imports: [],
    exports: [],
  });
  const app = defineApp({ id: "fixture-api", modules: [module] });
  return { app, executor: createExecutor(app), operation };
}

function createTransactionalFixture(
  controller: UnitOfWork<TransactionCapabilities>,
  handler: (arguments_: {
    readonly input: { readonly body: { readonly value: number } };
    readonly services: { readonly tx: TransactionCapabilities };
    readonly context: OperationContext;
  }) => unknown,
) {
  const operation = defineOperation({
    id: "fixture.write",
    input: { body: z.object({ value: z.number() }) },
    output: { 200: z.object({ value: z.number() }) },
    successStatus: 200,
    errors: [conflict],
    access: publicAccess(),
    transaction: "write",
    dependencies: { tx: transactionToken },
    handler,
  });
  const module = defineModule({
    id: "fixture",
    operations: [operation],
    providers: [valueProvider(transactionToken, controller)],
    imports: [],
    exports: [],
  });
  return createExecutor(defineApp({ id: "fixture-api", modules: [module] }));
}

const runOptions: OperationRunOptions = { requestId: "request-1" };

describe("createExecutor", () => {
  it("passes a verified identity independently from an application actor", async () => {
    const handler = vi.fn(() => ({ value: 2 }));
    const { executor } = createFixture({ handler });
    const identity = operationIdentity({ provider: "firebase", subject: "uid-1" });

    await executor.run("fixture.read", { params: { id: 1 } }, { identity });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ identity }) }),
    );
  });

  it("rejects an invalid verified identity from an untyped caller", async () => {
    const { executor } = createFixture();

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, {
        identity: { provider: "Firebase", subject: "uid-1" },
      } as never),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_CONTEXT_INVALID" });
  });

  it("makes transaction declarations execute and inject scoped capabilities", async () => {
    const modes: string[] = [];
    const capabilities: TransactionCapabilities = {
      records: { save: (value) => value * 3 },
    };
    const controller: UnitOfWork<TransactionCapabilities> = {
      kind: "ship.unit-of-work",
      id: "database.primary",
      async run(mode, work) {
        modes.push(mode);
        return work(capabilities);
      },
    };
    const handler = vi.fn(({ input, services }) => ({
      value: services.tx.records.save(input.body.value),
    }));
    const executor = createTransactionalFixture(controller, handler);

    await expect(
      executor.run("fixture.write", { body: { value: 4 } }, runOptions),
    ).resolves.toEqual({ ok: true, status: 200, data: { value: 12 }, requestId: "request-1" });
    expect(modes).toEqual(["write"]);
    expect(handler.mock.calls[0]?.[0].services.tx).toBe(capabilities);
    expect(handler.mock.calls[0]?.[0].services.tx).not.toBe(controller);
  });

  it("rolls back a declared failure before normalizing it as a result", async () => {
    let failureSeenByTransaction: unknown;
    const controller: UnitOfWork<TransactionCapabilities> = {
      kind: "ship.unit-of-work",
      id: "database.primary",
      async run(_mode, work) {
        try {
          return await work({ records: { save: (value) => value } });
        } catch (error) {
          failureSeenByTransaction = error;
          throw error;
        }
      },
    };
    const executor = createTransactionalFixture(controller, () => {
      throw operationFailure(conflict);
    });

    await expect(
      executor.run("fixture.write", { body: { value: 1 } }, runOptions),
    ).resolves.toMatchObject({ ok: false, status: 409, error: { code: "FIXTURE_CONFLICT" } });
    expect(failureSeenByTransaction).toBeInstanceOf(OperationFailure);
  });

  it("does not open a transaction before access and input checks pass", async () => {
    const run = vi.fn();
    const controller = {
      kind: "ship.unit-of-work" as const,
      id: "database.primary",
      run,
    } as UnitOfWork<TransactionCapabilities>;
    const executor = createTransactionalFixture(controller, () => ({ value: 1 }));

    await expect(
      executor.run("fixture.write", { body: { value: "invalid" } } as never, runOptions),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    expect(run).not.toHaveBeenCalled();
  });

  it("distinguishes transaction failures from handler failures", async () => {
    const transactionFailure = new Error("database unavailable");
    const controller: UnitOfWork<TransactionCapabilities> = {
      kind: "ship.unit-of-work",
      id: "database.primary",
      run: async () => {
        throw transactionFailure;
      },
    };
    const executor = createTransactionalFixture(controller, () => ({ value: 1 }));

    await expect(
      executor.run("fixture.write", { body: { value: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_TRANSACTION_FAILED",
      providerId: "database.primary",
      cause: transactionFailure,
    });
  });

  it("rejects a malformed controller returned by a unit-of-work provider", async () => {
    const provider = defineProvider({
      token: transactionToken,
      dependencies: {},
      lifetime: "singleton",
      create: () => ({ kind: "not-a-unit-of-work" }) as never,
    });
    const operation = defineOperation({
      id: "fixture.write",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "write",
      dependencies: { tx: transactionToken },
      handler: () => ({ ok: true as const }),
    });
    const module = defineModule({
      id: "fixture",
      operations: [operation],
      providers: [provider],
      imports: [],
      exports: [],
    });
    const executor = createExecutor(defineApp({ id: "fixture-api", modules: [module] }));

    await expect(executor.run("fixture.write", {}, runOptions)).rejects.toMatchObject({
      code: "SHIP_OPERATION_UNIT_OF_WORK_INVALID",
      providerId: "database.primary",
    });
  });

  it("validates and transforms input, resolves services, and validates output", async () => {
    const handler = vi.fn(({ input, services, context }: FixtureHandlerArguments) => {
      expect(input.params.id).toBe(3);
      expect(context.requestId).toBe("request-1");
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(services)).toBe(true);
      expect(Object.isFrozen(context)).toBe(true);
      return { value: services.fixture.multiply(input.params.id) };
    });
    const { executor } = createFixture({ handler });

    await expect(
      executor.run("fixture.read", { params: { id: "3" } }, runOptions),
    ).resolves.toEqual({ ok: true, status: 200, data: { value: 6 }, requestId: "request-1" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("projects reusable error definitions into the application graph", () => {
    const { app } = createFixture();

    expect(app.graph.operations[0].errors).toEqual([
      {
        code: "FIXTURE_CONFLICT",
        status: 409,
        message: "Fixture already exists",
      },
      {
        code: "FIXTURE_NOT_FOUND",
        status: 404,
        message: "Fixture not found",
        detailsVendor: "zod",
      },
    ]);
  });

  it("supports a typed alternate declared success status", async () => {
    const { executor } = createFixture({ handler: () => respond(202, { queued: true }) });

    await expect(executor.run("fixture.read", { params: { id: 1 } }, runOptions)).resolves.toEqual({
      ok: true,
      status: 202,
      data: { queued: true },
      requestId: "request-1",
    });
  });

  it("preserves normalized response headers on direct results", async () => {
    const { executor } = createFixture({
      handler: () => respond(202, { queued: true }, { headers: { ETag: '"fixture-1"' } }),
    });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).resolves.toMatchObject({
      ok: true,
      status: 202,
      headers: { etag: '"fixture-1"' },
    });
  });

  it("returns all deterministic input issues without constructing providers", async () => {
    const createService = vi.fn(() => ({ multiply: (value: number) => value }));
    const handler = vi.fn();
    const { executor } = createFixture({ createService, handler });

    const result = await executor.run(
      "fixture.read",
      { params: { id: "not-a-number" }, body: {} } as never,
      runOptions,
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: {
          issues: [
            { path: ["body"], code: "unrecognized_location" },
            { path: ["params", "id"], code: "invalid_type" },
          ],
        },
      },
      requestId: "request-1",
    });
    expect(createService).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("enforces authentication before input validation or provider resolution", async () => {
    const createService = vi.fn(() => ({ multiply: (value: number) => value }));
    const { executor } = createFixture({ access: authenticatedAccess(), createService });

    await expect(
      executor.run("fixture.read", { params: { id: "invalid" } }, runOptions),
    ).resolves.toEqual({
      ok: false,
      status: 401,
      error: { code: "AUTHENTICATION_ERROR", message: "Authentication required" },
      requestId: "request-1",
    });
    expect(createService).not.toHaveBeenCalled();
  });

  it("does not treat a malformed actor from an untyped adapter as authenticated", async () => {
    const { executor } = createFixture({ access: authenticatedAccess() });

    await expect(
      executor.run(
        "fixture.read",
        { params: { id: 1 } },
        { ...runOptions, actor: { id: "", kind: "human", permissions: new Set() } },
      ),
    ).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it("runs a kind-less (ship-core 1.0) actor as a human and still enforces permissions", async () => {
    const { executor } = createFixture({ access: permission("fixture:read") });

    const allowed = await executor.run(
      "fixture.read",
      { params: { id: 1 } },
      { ...runOptions, actor: { id: "actor-1", permissions: new Set(["fixture:read"]) } },
    );
    const denied = await executor.run(
      "fixture.read",
      { params: { id: 1 } },
      { ...runOptions, actor: { id: "actor-1", permissions: new Set(["other:read"]) } },
    );
    const asSystem = await createFixture({ access: systemAccess() }).executor.run(
      "fixture.read",
      { params: { id: 1 } },
      { ...runOptions, actor: { id: "actor-1" } },
    );

    expect(allowed).toMatchObject({ ok: true, status: 200 });
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "AUTHORIZATION_ERROR" },
    });
    expect(asSystem).toMatchObject({ ok: false, status: 403 });
  });

  it.each([
    [permission("fixture:read", "fixture:details"), new Set(["fixture:read"]), false],
    [
      permission("fixture:read", "fixture:details"),
      new Set(["fixture:read", "fixture:details"]),
      true,
    ],
    [anyPermission("fixture:read", "fixture:details"), new Set(["fixture:read"]), true],
    [anyPermission("fixture:read", "fixture:details"), new Set(["other:read"]), false],
  ])("enforces the declared permission composition", async (access, permissions, allowed) => {
    const { executor } = createFixture({ access });
    const result = await executor.run(
      "fixture.read",
      { params: { id: 2 } },
      { ...runOptions, actor: { id: "actor-1", kind: "human", permissions } },
    );

    expect(result.ok).toBe(allowed);
    expect(result.status).toBe(allowed ? 200 : 403);
    if (!allowed && !result.ok) {
      expect(result.error).toMatchObject({
        code: "AUTHORIZATION_ERROR",
        details: { requiredPermissions: access.permissions },
      });
    }
  });

  it.each([
    ["system access admits only system actors", systemAccess(), systemActor({ id: "job" }), true],
    ["system access rejects humans", systemAccess(), operationActor({ id: "user" }), false],
    [
      "system access rejects provider actors",
      systemAccess(),
      providerActor({ id: "evt", provider: "stripe" }),
      false,
    ],
    [
      "provider access admits the named provider",
      providerAccess("stripe"),
      providerActor({ id: "evt", provider: "stripe" }),
      true,
    ],
    [
      "provider access rejects another provider",
      providerAccess("stripe"),
      providerActor({ id: "evt", provider: "github" }),
      false,
    ],
    [
      "provider access rejects system actors even with permissions",
      providerAccess("stripe"),
      systemActor({ id: "job", permissions: ["fixture:read"] }),
      false,
    ],
  ])("%s", async (_name, access, actor, allowed) => {
    const handler = vi.fn(({ context }: FixtureHandlerArguments) => ({
      value: context.actor?.kind === actor.kind ? 1 : 0,
    }));
    const { executor } = createFixture({ access, handler });

    const result = await executor.run(
      "fixture.read",
      { params: { id: 2 } },
      { ...runOptions, actor },
    );

    expect(result.ok).toBe(allowed);
    if (allowed) {
      expect(result).toMatchObject({ status: 200, data: { value: 1 } });
    } else {
      expect(result).toMatchObject({
        status: 403,
        error: {
          code: "AUTHORIZATION_ERROR",
          details: { requiredPermissions: [], requiredActorKind: access.kind },
        },
      });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("does not grant system actors implicit permissions", async () => {
    const { executor } = createFixture({ access: permission("fixture:read") });

    await expect(
      executor.run(
        "fixture.read",
        { params: { id: 2 } },
        { ...runOptions, actor: systemActor({ id: "job" }) },
      ),
    ).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(
      executor.run(
        "fixture.read",
        { params: { id: 2 } },
        { ...runOptions, actor: systemActor({ id: "job", permissions: ["fixture:read"] }) },
      ),
    ).resolves.toMatchObject({ ok: true, status: 200 });
  });

  it("accepts a valid read-only permission set from another adapter realm", async () => {
    const permissions = {
      has: (permissionName: string) => permissionName === "fixture:read",
      *[Symbol.iterator]() {
        yield "fixture:read";
      },
    } as unknown as ReadonlySet<string>;
    const { executor } = createFixture({ access: permission("fixture:read") });

    await expect(
      executor.run(
        "fixture.read",
        { params: { id: 2 } },
        { ...runOptions, actor: { id: "actor-1", kind: "human", permissions } },
      ),
    ).resolves.toMatchObject({ ok: true, status: 200 });
  });

  it("normalizes a declared failure and validates its details", async () => {
    const { executor } = createFixture({
      handler: () => {
        throw operationFailure(notFound, { details: { id: 7 }, message: "No fixture 7" });
      },
    });

    await expect(executor.run("fixture.read", { params: { id: 7 } }, runOptions)).resolves.toEqual({
      ok: false,
      status: 404,
      error: { code: "FIXTURE_NOT_FOUND", message: "No fixture 7", details: { id: 7 } },
      requestId: "request-1",
    });
  });

  it("rejects an undeclared operation failure", async () => {
    const undeclared = operationError({ code: "OTHER_FAILURE", status: 422, message: "Other" });
    const { executor } = createFixture({
      handler: () => {
        throw operationFailure(undeclared);
      },
    });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_ERROR_UNDECLARED",
      operationId: "fixture.read",
      cause: expect.any(OperationFailure),
    });
  });

  it("rejects headers from a same-code error with an undeclared status", async () => {
    const declared = operationError({
      code: "RATE_LIMITED",
      status: 429,
      message: "Later",
      headers: ["Retry-After"] as const,
    });
    const mismatched = operationError({
      code: "RATE_LIMITED",
      status: 503,
      message: "Later",
      headers: ["Retry-After"] as const,
    });
    const { executor } = createFixture({
      errors: [declared],
      handler: () => {
        throw operationFailure(mismatched, { headers: { "Retry-After": "120" } });
      },
    });
    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_ERROR_UNDECLARED",
    });
  });

  it("rejects invalid declared-error details", async () => {
    const { executor } = createFixture({
      handler: () => {
        throw new OperationFailure(notFound, { details: { id: "bad" } as never });
      },
    });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_ERROR_DETAILS_INVALID",
      issues: [expect.objectContaining({ path: ["id"] })],
    });
  });

  it.each([
    [() => ({ value: "invalid" }), "SHIP_OPERATION_OUTPUT_INVALID"],
    [() => respond(201, { value: 1 }), "SHIP_OPERATION_RESPONSE_STATUS_UNDECLARED"],
  ])("rejects an invalid handler result", async (handler, code) => {
    const { executor } = createFixture({ handler });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code,
      operationId: "fixture.read",
    });
  });

  it("wraps an unexpected handler failure without losing its cause", async () => {
    const cause = new Error("private database message");
    const { executor } = createFixture({
      handler: () => {
        throw cause;
      },
    });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
      message: 'operation "fixture.read" handler failed',
      cause,
    });
  });

  it("returns the 500 envelope from tryRun where run would throw, and nothing else changes", async () => {
    const cause = new Error("private database message");
    const { executor } = createFixture({
      handler: ({ input }) => {
        if (input.params.id === 1) throw cause;
        return { value: input.params.id };
      },
    });

    const failed = await executor.tryRun(
      "fixture.read",
      { params: { id: 1 } },
      {
        ...runOptions,
        requestId: "  req-9  ",
      },
    );
    expect(failed).toEqual({
      ok: false,
      status: 500,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
        details: { code: "SHIP_OPERATION_HANDLER_FAILED", operationId: "fixture.read" },
      },
      requestId: "req-9",
      cause: expect.objectContaining({ code: "SHIP_OPERATION_HANDLER_FAILED", cause }),
    });
    expect(Object.isFrozen(failed)).toBe(true);
    // Declared outcomes are untouched and a missing request id is generated once for both.
    const succeeded = await executor.tryRun("fixture.read", { params: { id: 2 } }, runOptions);
    expect(succeeded).toMatchObject({ ok: true, status: 200, data: { value: 2 } });
    expect(typeof succeeded.requestId).toBe("string");
    const invalid = await executor.tryRun("fixture.read", { params: { id: "x" } }, runOptions);
    expect(invalid).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_ERROR" } });
    const missing = await executor.tryRun("fixture.missing" as never, {} as never, runOptions);
    expect(missing).toMatchObject({
      ok: false,
      status: 500,
      error: { details: { code: "SHIP_OPERATION_NOT_FOUND", operationId: "fixture.missing" } },
    });
    // Only execution errors are absorbed; a foreign throw from a broken signal still escapes run().
    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toBeInstanceOf(OperationExecutionError);
  });

  it("constructs a singleton once across concurrent runs", async () => {
    const createService = vi.fn(async () => {
      await Promise.resolve();
      return { multiply: (value: number) => value };
    });
    const { executor } = createFixture({ lifetime: "singleton", createService });

    await Promise.all([
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
      executor.run("fixture.read", { params: { id: 2 } }, { requestId: "request-2" }),
    ]);

    expect(createService).toHaveBeenCalledOnce();
  });

  it("constructs an operation provider once per run", async () => {
    const createService = vi.fn(() => ({ multiply: (value: number) => value }));
    const { executor } = createFixture({ lifetime: "operation", createService });

    await executor.run("fixture.read", { params: { id: 1 } }, runOptions);
    await executor.run("fixture.read", { params: { id: 2 } }, { requestId: "request-2" });

    expect(createService).toHaveBeenCalledTimes(2);
  });

  it("resolves provider dependencies and reuses one operation-scoped instance", async () => {
    const multiplierToken = dependency<number>("fixture.multiplier");
    const createMultiplier = vi.fn(() => 3);
    const multiplierProvider = defineProvider({
      token: multiplierToken,
      dependencies: {},
      lifetime: "operation",
      create: createMultiplier,
    });
    const createService = vi.fn(({ services }: { services: { readonly multiplier: number } }) => ({
      multiply: (value: number) => value * services.multiplier,
    }));
    const serviceProvider = defineProvider({
      token: serviceToken,
      dependencies: { multiplier: multiplierToken },
      lifetime: "operation",
      create: createService,
    });
    const operation = defineOperation({
      id: "fixture.multiply",
      input: { body: z.object({ value: z.number() }) },
      output: { 200: z.object({ value: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { fixture: serviceToken, multiplier: multiplierToken },
      handler: ({ input, services }) => ({
        value: services.fixture.multiply(input.body.value) + services.multiplier,
      }),
    });
    const module = defineModule({
      id: "fixture",
      operations: [operation],
      providers: [multiplierProvider, serviceProvider],
      imports: [],
      exports: [],
    });
    const executor = createExecutor(defineApp({ id: "fixture-api", modules: [module] }));

    await expect(
      executor.run("fixture.multiply", { body: { value: 2 } }, runOptions),
    ).resolves.toMatchObject({ ok: true, data: { value: 9 } });
    expect(createMultiplier).toHaveBeenCalledOnce();
    expect(createService).toHaveBeenCalledOnce();
  });

  it("retries a rejected singleton construction on the next run", async () => {
    const createService = vi
      .fn<() => Promise<FixtureService>>()
      .mockRejectedValueOnce(new Error("boot failed"))
      .mockResolvedValue({ multiply: (value) => value });
    const { executor } = createFixture({ lifetime: "singleton", createService });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code: "SHIP_PROVIDER_INITIALIZATION_FAILED",
      providerId: "fixture.service",
    });
    await expect(
      executor.run("fixture.read", { params: { id: 2 } }, { requestId: "request-2" }),
    ).resolves.toMatchObject({ ok: true, data: { value: 2 } });
    expect(createService).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown operation id for untyped callers", async () => {
    const { executor } = createFixture();
    const runtimeRun = executor.run as (id: string, input: unknown) => Promise<unknown>;

    await expect(runtimeRun("fixture.missing", {})).rejects.toMatchObject({
      code: "SHIP_OPERATION_NOT_FOUND",
      operationId: "fixture.missing",
    });
  });

  it("stops an already-aborted operation before provider construction", async () => {
    const createService = vi.fn(() => ({ multiply: (value: number) => value }));
    const controller = new AbortController();
    controller.abort("cancelled");
    const { executor } = createFixture({ createService });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_ABORTED", cause: "cancelled" });
    expect(createService).not.toHaveBeenCalled();
  });

  it("checks cancellation again after an asynchronous handler", async () => {
    const controller = new AbortController();
    const { executor } = createFixture({
      handler: async () => {
        controller.abort("cancelled during work");
        return { value: 1 };
      },
    });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_ABORTED", cause: "cancelled during work" });
  });

  it("checks cancellation after asynchronous output validation", async () => {
    const controller = new AbortController();
    const { executor } = createFixture({
      outputSchema: z.object({ value: z.number() }).transform(async (value) => {
        controller.abort("cancelled during validation");
        return value;
      }),
    });
    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_ABORTED" });
  });

  it("turns a schema implementation crash into a stable diagnostic", async () => {
    const cause = new Error("schema bug");
    const schema: RuntimeSchema = {
      "~standard": {
        version: 1,
        vendor: "broken",
        validate: () => {
          throw cause;
        },
      },
    };
    const { executor } = createFixture({ inputSchema: schema });

    await expect(executor.run("fixture.read", { params: {} }, runOptions)).rejects.toMatchObject({
      code: "SHIP_OPERATION_INPUT_SCHEMA_FAILED",
      operationId: "fixture.read",
      cause,
    });
  });

  it("distinguishes output schema crashes from invalid output", async () => {
    const cause = new Error("output schema bug");
    const schema: RuntimeSchema = {
      "~standard": {
        version: 1,
        vendor: "broken",
        validate: () => {
          throw cause;
        },
      },
    };
    const { executor } = createFixture({ outputSchema: schema, handler: () => ({ value: 1 }) });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_OUTPUT_SCHEMA_FAILED",
      operationId: "fixture.read",
      cause,
    });
  });

  it("distinguishes declared-error schema crashes from invalid details", async () => {
    const cause = new Error("error schema bug");
    const details: RuntimeSchema = {
      "~standard": {
        version: 1,
        vendor: "broken",
        validate: () => {
          throw cause;
        },
      },
    };
    const broken = operationError({
      code: "BROKEN_DETAILS",
      status: 422,
      message: "Broken details",
      details,
    });
    const { executor } = createFixture({
      errors: [broken],
      handler: () => {
        throw operationFailure(broken, { details: "value" });
      },
    });

    await expect(
      executor.run("fixture.read", { params: { id: 1 } }, runOptions),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_ERROR_SCHEMA_FAILED",
      operationId: "fixture.read",
      cause,
    });
  });

  it("generates a request id when the caller does not supply one", async () => {
    const { executor } = createFixture();
    const result = await executor.run("fixture.read", { params: { id: 1 } });

    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("replaces an empty request id instead of publishing unusable correlation metadata", async () => {
    const { executor } = createFixture();
    const result = await executor.run("fixture.read", { params: { id: 1 } }, { requestId: "   " });

    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("transaction isolation and retry", () => {
  type Transaction = OperationTransactionDeclaration;

  /** SQLSTATE-shaped failure the way a driver raises it. */
  function sqlstate(code: string): Error & { code: string } {
    return Object.assign(new Error(`SQLSTATE ${code}`), { code });
  }

  /** Classifies like the Drizzle adapter: SQLSTATE anywhere in the cause chain. */
  function classify(error: unknown): "serialization" | "deadlock" | undefined {
    for (let current = error; typeof current === "object" && current !== null; ) {
      const code = Reflect.get(current, "code");
      if (code === "40001") return "serialization";
      if (code === "40P01") return "deadlock";
      current = Reflect.get(current, "cause");
    }
    return undefined;
  }

  /**
   * A controller that records every scope it opens, the options it received,
   * and how many scopes committed (work resolved) versus rolled back.
   */
  function controller(options: { readonly failCommit?: (attempt: number) => unknown } = {}) {
    const scopes: { readonly id: number; readonly options: unknown }[] = [];
    const state = { commits: 0, rollbacks: 0 };
    const capabilitiesByScope: object[] = [];
    const unitOfWork: UnitOfWork<TransactionCapabilities> = {
      kind: "ship.unit-of-work",
      id: "database.primary",
      classifyFailure: classify,
      async run(_mode, work, runOptions) {
        const id = scopes.length + 1;
        scopes.push({ id, options: runOptions });
        const capabilities: TransactionCapabilities = { records: { save: (value) => value } };
        capabilitiesByScope.push(capabilities);
        try {
          const result = await work(capabilities);
          const commitFailure = options.failCommit?.(id);
          if (commitFailure !== undefined) throw commitFailure;
          state.commits += 1;
          return result;
        } catch (error) {
          state.rollbacks += 1;
          throw error;
        }
      },
    };
    return { unitOfWork, scopes, state, capabilitiesByScope };
  }

  function fixture(
    transaction: Transaction,
    unitOfWork: UnitOfWork<TransactionCapabilities>,
    handler: (arguments_: {
      readonly input: { readonly body: { readonly value: number } };
      readonly services: { readonly tx: TransactionCapabilities };
    }) => unknown,
  ) {
    const operation = defineOperation({
      id: "fixture.write",
      input: { body: z.object({ value: z.number() }) },
      output: { 200: z.object({ value: z.number() }) },
      successStatus: 200,
      errors: [conflict, notFound],
      access: publicAccess(),
      transaction: transaction as "write",
      dependencies: { tx: transactionToken },
      handler,
    });
    const module = defineModule({
      id: "fixture",
      operations: [operation],
      providers: [valueProvider(transactionToken, unitOfWork)],
      imports: [],
      exports: [],
    });
    return createExecutor(defineApp({ id: "fixture-api", modules: [module] }));
  }

  const serializable: Transaction = {
    mode: "write",
    isolation: "serializable",
    retry: { on: ["serialization"], attempts: 3 },
  };

  it("passes a non-default isolation level to the unit of work and nothing for the default", async () => {
    const strict = controller();
    await fixture(serializable, strict.unitOfWork, () => ({ value: 1 })).run(
      "fixture.write",
      { body: { value: 1 } },
      runOptions,
    );
    expect(strict.scopes.map((scope) => scope.options)).toEqual([{ isolation: "serializable" }]);

    const plain = controller();
    await fixture("write", plain.unitOfWork, () => ({ value: 1 })).run(
      "fixture.write",
      { body: { value: 1 } },
      runOptions,
    );
    const explicit = controller();
    await fixture({ mode: "write", isolation: "read committed" }, explicit.unitOfWork, () => ({
      value: 1,
    })).run("fixture.write", { body: { value: 1 } }, runOptions);
    expect(plain.scopes.map((scope) => scope.options)).toEqual([undefined]);
    expect(explicit.scopes.map((scope) => scope.options)).toEqual([undefined]);
  });

  it("re-runs the handler in a fresh unit of work after a serialization failure at commit", async () => {
    const db = controller({
      failCommit: (attempt) => (attempt === 1 ? sqlstate("40001") : undefined),
    });
    const handler = vi.fn(({ input, services }) => ({
      value: services.tx.records.save(input.body.value),
    }));

    await expect(
      fixture(serializable, db.unitOfWork, handler).run(
        "fixture.write",
        { body: { value: 7 } },
        runOptions,
      ),
    ).resolves.toEqual({
      ok: true,
      status: 200,
      data: { value: 7 },
      requestId: "request-1",
      attempts: 2,
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(db.state).toEqual({ commits: 1, rollbacks: 1 });
    expect(handler.mock.calls[0]?.[0].services.tx).toBe(db.capabilitiesByScope[0]);
    expect(handler.mock.calls[1]?.[0].services.tx).toBe(db.capabilitiesByScope[1]);
    expect(handler.mock.calls[1]?.[0].services.tx).not.toBe(db.capabilitiesByScope[0]);
  });

  it("retries a driver failure the handler surfaced, wrapped by the handler-failure diagnostic", async () => {
    const db = controller();
    let calls = 0;
    const handler = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw sqlstate("40P01");
      return { value: 1 };
    });

    await expect(
      fixture(
        { mode: "write", retry: { on: ["deadlock"], attempts: 2 } },
        db.unitOfWork,
        handler,
      ).run("fixture.write", { body: { value: 1 } }, runOptions),
    ).resolves.toMatchObject({ ok: true, attempts: 2 });
    expect(db.state).toEqual({ commits: 1, rollbacks: 1 });
  });

  it("stops at the declared attempt count and surfaces the last transient failure", async () => {
    const db = controller({ failCommit: () => sqlstate("40001") });
    const handler = vi.fn(() => ({ value: 1 }));

    await expect(
      fixture(serializable, db.unitOfWork, handler).run(
        "fixture.write",
        { body: { value: 1 } },
        runOptions,
      ),
    ).rejects.toMatchObject({
      code: "SHIP_OPERATION_TRANSACTION_FAILED",
      cause: expect.objectContaining({ code: "40001" }),
    });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(db.state).toEqual({ commits: 0, rollbacks: 3 });
  });

  it("retries a declared error code listed in the policy and returns the last failure with its attempts", async () => {
    const db = controller();
    const handler = vi.fn(() => {
      throw operationFailure(conflict);
    });

    await expect(
      fixture(
        { mode: "write", retry: { on: ["FIXTURE_CONFLICT"], attempts: 2 } },
        db.unitOfWork,
        handler,
      ).run("fixture.write", { body: { value: 1 } }, runOptions),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "FIXTURE_CONFLICT" },
      attempts: 2,
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(db.state).toEqual({ commits: 0, rollbacks: 2 });
  });

  it("never retries a declared failure the policy does not list", async () => {
    const db = controller();
    const handler = vi.fn(() => {
      throw operationFailure(notFound, { details: { id: 1 } });
    });

    await expect(
      fixture(serializable, db.unitOfWork, handler).run(
        "fixture.write",
        { body: { value: 1 } },
        runOptions,
      ),
    ).resolves.toMatchObject({ ok: false, status: 404, attempts: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("never retries a transient kind the policy does not list, nor an unclassified failure", async () => {
    const deadlocked = controller({ failCommit: () => sqlstate("40P01") });
    await expect(
      fixture(serializable, deadlocked.unitOfWork, () => ({ value: 1 })).run(
        "fixture.write",
        { body: { value: 1 } },
        runOptions,
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_TRANSACTION_FAILED" });
    expect(deadlocked.state).toEqual({ commits: 0, rollbacks: 1 });

    const unavailable = controller({ failCommit: () => new Error("connection reset") });
    await expect(
      fixture(serializable, unavailable.unitOfWork, () => ({ value: 1 })).run(
        "fixture.write",
        { body: { value: 1 } },
        runOptions,
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_TRANSACTION_FAILED" });
    expect(unavailable.state).toEqual({ commits: 0, rollbacks: 1 });

    const crashed = controller();
    const handler = vi.fn(() => {
      throw new Error("handler defect");
    });
    await expect(
      fixture(serializable, crashed.unitOfWork, handler).run(
        "fixture.write",
        { body: { value: 1 } },
        runOptions,
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_HANDLER_FAILED" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries declared codes alone when the unit of work cannot classify driver failures", async () => {
    const db = controller({
      failCommit: (attempt) => (attempt === 1 ? sqlstate("40001") : undefined),
    });
    const unclassifying: UnitOfWork<TransactionCapabilities> = {
      kind: "ship.unit-of-work",
      id: "database.primary",
      run: db.unitOfWork.run,
    };

    await expect(
      fixture(serializable, unclassifying, () => ({ value: 1 })).run(
        "fixture.write",
        { body: { value: 1 } },
        runOptions,
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_TRANSACTION_FAILED" });
    expect(db.state).toEqual({ commits: 0, rollbacks: 1 });
  });

  it("does not retry once the caller has aborted", async () => {
    const abort = new AbortController();
    const db = controller({
      failCommit: () => {
        abort.abort();
        return sqlstate("40001");
      },
    });

    await expect(
      fixture(serializable, db.unitOfWork, () => ({ value: 1 })).run(
        "fixture.write",
        { body: { value: 1 } },
        { ...runOptions, signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_TRANSACTION_FAILED" });
    expect(db.state).toEqual({ commits: 0, rollbacks: 1 });
  });

  it("reports no attempt count when the operation declares no retry policy", async () => {
    const db = controller();
    const result = await fixture(
      { mode: "write", isolation: "repeatable read" },
      db.unitOfWork,
      () => ({ value: 1 }),
    ).run("fixture.write", { body: { value: 1 } }, runOptions);

    expect(result).toEqual({ ok: true, status: 200, data: { value: 1 }, requestId: "request-1" });
    expect("attempts" in result).toBe(false);
  });
});

describe("declared redirect results", () => {
  const location = "https://app.example.test/oauth?connected=true";
  const invalidState = operationError({
    code: "OAUTH_STATE_INVALID",
    status: 400,
    message: "OAuth state is invalid",
  });

  function redirectApp(
    handler: (arguments_: {
      readonly input: { readonly query: { readonly code: string; readonly state: string } };
    }) => unknown,
    options: { readonly statuses?: readonly number[]; readonly successStatus?: number } = {},
  ) {
    const statuses = options.statuses ?? [302];
    const operation = defineOperation({
      id: "oauth.callback",
      transport: {
        kind: "http",
        binding: "GET /oauth/callback",
        metadata: {
          method: "GET",
          path: "/oauth/callback",
          response: "redirect",
          queryParsing: "first-value",
        },
      },
      input: { query: z.object({ code: z.string().min(1), state: z.string().min(1) }) },
      output: Object.fromEntries(statuses.map((status) => [status, z.undefined()])) as Record<
        302,
        z.ZodUndefined
      >,
      successStatus: (options.successStatus ?? statuses[0]) as 302,
      errors: [invalidState],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: handler as never,
    });
    const module = defineModule({
      id: "oauth",
      operations: [operation],
      providers: [],
      imports: [],
      exports: [],
    });
    return createExecutor(defineApp({ id: "oauth-fixture", modules: [module] }));
  }

  const input = { query: { code: "code-1", state: "state-1" } };

  it.each([
    301, 302, 303, 307, 308,
  ])("returns an empty %s with its Location as a direct result header", async (status) => {
    const executor = redirectApp(
      () => respond(status, undefined, { headers: { Location: location } }),
      { statuses: [status] },
    );

    await expect(executor.run("oauth.callback", input, runOptions)).resolves.toEqual({
      ok: true,
      status,
      data: undefined,
      requestId: "request-1",
      headers: { location },
    });
  });

  it("lets a handler choose a failure redirect while declared failures stay results", async () => {
    const executor = redirectApp(({ input: { query } }) => {
      if (query.state === "revoked") throw operationFailure(invalidState);
      if (query.state !== "state-1") {
        return respond(302, undefined, {
          headers: { Location: "https://app.example.test/oauth?error=invalid_state" },
        });
      }
      return respond(302, undefined, { headers: { Location: location } });
    });

    await expect(
      executor.run("oauth.callback", { query: { code: "c", state: "tampered" } }, runOptions),
    ).resolves.toMatchObject({
      ok: true,
      status: 302,
      headers: { location: "https://app.example.test/oauth?error=invalid_state" },
    });
    const declared = await executor.run(
      "oauth.callback",
      { query: { code: "c", state: "revoked" } },
      runOptions,
    );
    expect(declared).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "OAUTH_STATE_INVALID", message: "OAuth state is invalid" },
    });
    expect(declared).not.toHaveProperty("headers");
    const validation = await executor.run("oauth.callback", { query: { code: "" } }, runOptions);
    expect(validation).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("accepts root-relative and absolute HTTP(S) locations", async () => {
    for (const safe of [
      "/oauth/done?connected=true#calendar",
      "http://localhost:4200/oauth/done",
      "HTTPS://App.Example.test/done",
    ]) {
      const executor = redirectApp(() => respond(302, undefined, { headers: { Location: safe } }));
      await expect(executor.run("oauth.callback", input, runOptions)).resolves.toMatchObject({
        ok: true,
        status: 302,
        headers: { location: safe },
      });
    }
  });

  it.each([
    ["a protocol-relative URL", "//evil.example/phish"],
    ["a backslash protocol-relative URL", "/\\evil.example/phish"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a mailto: URL", "mailto:victim@example.test"],
    ["embedded credentials", "https://user:pass@app.example.test/"],
    ["leading whitespace", " https://app.example.test/"],
    ["trailing whitespace", "https://app.example.test/ "],
    ["a tab control character", "https://app.example.test/\tpath"],
    ["a NUL control character", "https://app.example.test/\u0000"],
    ["a DEL control character", "https://app.example.test/\u007f"],
    ["an empty value", ""],
    ["a relative path without a leading slash", "oauth/done"],
  ])("rejects %s before producing a redirect", async (_name, unsafe) => {
    const executor = redirectApp(() => respond(302, undefined, { headers: { Location: unsafe } }));

    await expect(executor.run("oauth.callback", input, runOptions)).rejects.toMatchObject({
      code: "SHIP_OPERATION_OUTPUT_INVALID",
      operationId: "oauth.callback",
    });
  });

  it("rejects header injection through CRLF inside the Location value", async () => {
    const executor = redirectApp(() =>
      respond(302, undefined, {
        headers: { Location: "https://app.example.test/\r\nSet-Cookie: session=hijacked" },
      }),
    );

    await expect(executor.run("oauth.callback", input, runOptions)).rejects.toMatchObject({
      code: "SHIP_OPERATION_HANDLER_FAILED",
      operationId: "oauth.callback",
    });
  });

  it("rejects a redirect with a body, a missing Location, or a terse return", async () => {
    for (const handler of [
      () => respond(302, { ok: true } as never, { headers: { Location: location } }),
      () => respond(302, undefined),
      () => respond(302, undefined, { headers: { "x-location": location } }),
      () => undefined,
    ]) {
      const executor = redirectApp(handler);
      await expect(executor.run("oauth.callback", input, runOptions)).rejects.toMatchObject({
        code: "SHIP_OPERATION_OUTPUT_INVALID",
        operationId: "oauth.callback",
      });
    }
  });

  it("rejects an undeclared redirect status", async () => {
    const executor = redirectApp(() =>
      respond(303, undefined, { headers: { Location: location } }),
    );

    await expect(executor.run("oauth.callback", input, runOptions)).rejects.toMatchObject({
      code: "SHIP_OPERATION_RESPONSE_STATUS_UNDECLARED",
      operationId: "oauth.callback",
    });
  });

  it("returns the safe 500 envelope from tryRun for an unsafe Location", async () => {
    const executor = redirectApp(() =>
      respond(302, undefined, { headers: { Location: "//evil.example" } }),
    );

    await expect(executor.tryRun("oauth.callback", input, runOptions)).resolves.toMatchObject({
      ok: false,
      status: 500,
      error: { code: "INTERNAL_SERVER_ERROR" },
    });
  });
});
