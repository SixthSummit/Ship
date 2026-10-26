import { describe, expect, it } from "vitest";
import { z } from "zod";
import { publicAccess } from "./access.js";
import {
  ApplicationCompilationError,
  type ApplicationDiagnosticCode,
  compileApp,
  defineApp,
} from "./application.js";
import {
  type DependencyBindings,
  type DependencyToken,
  dependency,
  effectDependency,
  type UnitOfWork,
  unitOfWorkDependency,
} from "./dependency.js";
import { type AnyModule, defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import { defineProvider } from "./provider.js";

const clockToken = dependency<{ now(): Date }>("platform.clock");
const accountsToken = dependency<{ count(): number }>("accounts.repository");
const missingToken = dependency<{ value: string }>("missing.service");
const unitOfWorkToken = unitOfWorkDependency<{ readonly repository: { save(): void } }>(
  "database.primary",
);
const emailEffectToken = effectDependency<{ send(): Promise<void> }>("email.send", {
  delivery: "immediate",
});

function operation(id: string, dependencies: DependencyBindings = {}, binding?: string) {
  return defineOperation({
    id,
    input: {},
    output: { 200: z.object({ ok: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies,
    ...(binding ? { transport: { kind: "http", binding } } : {}),
    handler: () => ({ ok: true as const }),
  });
}

function provider<TValue>(
  token: DependencyToken<TValue, unknown>,
  dependencies: DependencyBindings = {},
  lifetime: "singleton" | "operation" = "operation",
) {
  return defineProvider({
    token,
    dependencies,
    lifetime,
    create: () => ({}) as TValue,
  });
}

function module(
  id: string,
  options: {
    operations?: readonly ReturnType<typeof operation>[];
    providers?: readonly ReturnType<typeof provider>[];
    imports?: readonly string[];
    exports?: readonly DependencyToken<unknown, unknown>[];
  } = {},
) {
  return defineModule({
    id,
    operations: options.operations ?? [],
    providers: options.providers ?? [],
    imports: options.imports ?? [],
    exports: options.exports ?? [],
  });
}

function validModules(): readonly AnyModule[] {
  const platform = module("platform", {
    providers: [provider(clockToken)],
    exports: [clockToken],
  });
  const accounts = module("accounts", {
    operations: [operation("accounts.count", { accounts: accountsToken })],
    providers: [provider(accountsToken, { clock: clockToken })],
    imports: ["platform"],
    exports: [accountsToken],
  });
  return [accounts, platform];
}

function diagnosticCodes(modules: readonly AnyModule[]): readonly ApplicationDiagnosticCode[] {
  try {
    compileApp({ id: "fixture-api", modules });
    throw new Error("expected compilation to fail");
  } catch (error) {
    if (!(error instanceof ApplicationCompilationError)) throw error;
    return error.diagnostics.map((diagnostic) => diagnostic.code);
  }
}

describe("compileApp", () => {
  it("compiles immutable lookup tables and a serializable graph", () => {
    const app = defineApp({ id: "fixture-api", modules: validModules() });

    expect(app.kind).toBe("ship.application");
    expect(app.id).toBe("fixture-api");
    expect(Object.keys(app.moduleById)).toEqual(["accounts", "platform"]);
    expect(Object.keys(app.operationById)).toEqual(["accounts.count"]);
    expect(Object.keys(app.providerById)).toEqual(["accounts.repository", "platform.clock"]);
    expect(Object.isFrozen(app)).toBe(true);
    expect(Object.isFrozen(app.moduleById)).toBe(true);
    expect(Object.isFrozen(app.operationById)).toBe(true);
    expect(Object.isFrozen(app.providerById)).toBe(true);
    expect(Object.isFrozen(app.graph)).toBe(true);

    expect(app.graph).toEqual({
      schemaVersion: 1,
      appId: "fixture-api",
      modules: [
        {
          id: "accounts",
          imports: ["platform"],
          operations: ["accounts.count"],
          providers: ["accounts.repository"],
          exports: ["accounts.repository"],
          channels: [],
          attachments: [],
          mailers: [],
          richText: [],
        },
        {
          id: "platform",
          imports: [],
          operations: [],
          providers: ["platform.clock"],
          exports: ["platform.clock"],
          channels: [],
          attachments: [],
          mailers: [],
          richText: [],
        },
      ],
      operations: [
        {
          id: "accounts.count",
          moduleId: "accounts",
          input: [],
          output: [{ status: 200, vendor: "zod" }],
          successStatus: 200,
          errors: [],
          access: { kind: "public" },
          transaction: "none",
          dependencies: [{ name: "accounts", providerId: "accounts.repository" }],
          effects: [],
          publishes: [],
        },
      ],
      providers: [
        {
          id: "accounts.repository",
          moduleId: "accounts",
          lifetime: "operation",
          dependencies: [{ name: "clock", providerId: "platform.clock" }],
        },
        {
          id: "platform.clock",
          moduleId: "platform",
          lifetime: "operation",
          dependencies: [],
        },
      ],
      outboxes: [],
      channels: [],
      jobs: [],
      attachments: [],
      mailers: [],
      richText: [],
    });

    const serialized = JSON.stringify(app.graph);
    expect(serialized).not.toContain("handler");
    expect(serialized).not.toContain("create");
    expect(JSON.parse(serialized)).toEqual(app.graph);
  });

  it("projects the executable unit-of-work boundary into the graph", () => {
    const operation = defineOperation({
      id: "accounts.save",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "write",
      dependencies: { tx: unitOfWorkToken },
      handler: ({ services }) => {
        services.tx.repository.save();
        return { ok: true as const };
      },
    });
    const controller: UnitOfWork<{ readonly repository: { save(): void } }> = {
      kind: "ship.unit-of-work",
      id: "database.primary",
      run: async (_mode, work) => work({ repository: { save() {} } }),
    };
    const database = module("accounts", {
      operations: [operation as never],
      providers: [
        defineProvider({
          token: unitOfWorkToken,
          dependencies: {},
          lifetime: "singleton",
          create: () => controller,
        }) as never,
      ],
    });

    const app = defineApp({ id: "fixture-api", modules: [database] });

    expect(app.graph.operations[0].dependencies).toEqual([
      { name: "tx", providerId: "database.primary", scope: "unit-of-work" },
    ]);
    expect(app.graph.providers[0]).toMatchObject({
      id: "database.primary",
      lifetime: "singleton",
      scope: "unit-of-work",
    });
  });

  it.each([
    false,
    true,
  ])("rejects captive operation providers through a singleton chain: %s", (transitive) => {
    const scoped = dependency("test.scoped");
    const middle = dependency("test.middle");
    const root = dependency("test.root");
    expect(() =>
      defineApp({
        id: "test",
        modules: [
          module("test", {
            providers: [
              provider(scoped),
              ...(transitive ? [provider(middle, { scoped }, "singleton")] : []),
              provider(root, transitive ? { middle } : { scoped }, "singleton"),
            ],
          }),
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "SHIP_PROVIDER_LIFETIME_INVALID" }),
        ]),
      }),
    );
  });

  it.each([
    [
      "transaction without unit of work",
      defineOperation({
        ...operation("accounts.read"),
        transaction: "read",
      }),
      [],
      ["SHIP_OPERATION_UNIT_OF_WORK_REQUIRED"],
    ],
    [
      "non-transactional unit of work",
      defineOperation({
        ...operation("accounts.read"),
        dependencies: { tx: unitOfWorkToken },
      }),
      [provider(unitOfWorkToken, {}, "singleton")],
      ["SHIP_OPERATION_UNIT_OF_WORK_FORBIDDEN"],
    ],
  ] satisfies readonly [
    string,
    ReturnType<typeof operation>,
    readonly ReturnType<typeof provider>[],
    readonly ApplicationDiagnosticCode[],
  ][])("rejects %s", (_name, operation, providers, codes) => {
    expect(diagnosticCodes([module("accounts", { operations: [operation], providers })])).toEqual(
      codes,
    );
  });

  it("rejects multiple unit-of-work dependencies", () => {
    const secondary = unitOfWorkDependency<{ readonly repository: unknown }>("database.secondary");
    const operation = defineOperation({
      id: "accounts.save",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "write",
      dependencies: { primary: unitOfWorkToken, secondary },
      handler: () => ({ ok: true as const }),
    });

    expect(
      diagnosticCodes([
        module("accounts", {
          operations: [operation as never],
          providers: [
            provider(unitOfWorkToken, {}, "singleton"),
            provider(secondary, {}, "singleton"),
          ],
        }),
      ]),
    ).toEqual(["SHIP_OPERATION_UNIT_OF_WORK_MULTIPLE"]);
  });

  it("rejects unit-of-work dependencies in provider factories", () => {
    expect(
      diagnosticCodes([
        module("accounts", {
          providers: [
            provider(unitOfWorkToken, {}, "singleton"),
            provider(accountsToken, { tx: unitOfWorkToken }),
          ],
        }),
      ]),
    ).toEqual(["SHIP_PROVIDER_UNIT_OF_WORK_FORBIDDEN"]);
  });

  it("requires a singleton unit-of-work controller", () => {
    expect(
      diagnosticCodes([
        module("accounts", { providers: [provider(unitOfWorkToken, {}, "operation")] }),
      ]),
    ).toEqual(["SHIP_UNIT_OF_WORK_PROVIDER_LIFETIME_INVALID"]);
  });

  it("projects explicitly declared effects and their selected providers", () => {
    const send = defineOperation({
      ...operation("notifications.send", { mailer: emailEffectToken }),
      effects: [emailEffectToken],
    });
    const app = defineApp({
      id: "fixture-api",
      modules: [
        module("notifications", {
          operations: [send],
          providers: [provider(emailEffectToken)],
        }),
      ],
    });

    expect(app.graph.operations[0]).toMatchObject({
      effects: [{ id: "email.send", delivery: "immediate" }],
      dependencies: [{ name: "mailer", providerId: "email.send", scope: "effect" }],
    });
    expect(app.graph.providers[0]).toMatchObject({
      id: "email.send",
      scope: "effect",
      delivery: "immediate",
    });
  });

  it.each([
    [
      "undeclared effect dependency",
      defineOperation({ ...operation("notifications.send", { mailer: emailEffectToken }) }),
      [provider(emailEffectToken)],
      ["SHIP_OPERATION_EFFECT_UNDECLARED"],
    ],
    [
      "unbound effect declaration",
      defineOperation({ ...operation("notifications.send"), effects: [emailEffectToken] }),
      [],
      ["SHIP_OPERATION_EFFECT_UNBOUND"],
    ],
    [
      "immediate effect in a transaction",
      defineOperation({
        ...operation("notifications.send", {
          transaction: unitOfWorkToken,
          mailer: emailEffectToken,
        }),
        transaction: "write",
        effects: [emailEffectToken],
      }),
      [provider(unitOfWorkToken, {}, "singleton"), provider(emailEffectToken)],
      ["SHIP_OPERATION_EFFECT_TRANSACTION_FORBIDDEN"],
    ],
  ] satisfies readonly [
    string,
    ReturnType<typeof operation>,
    readonly ReturnType<typeof provider>[],
    readonly ApplicationDiagnosticCode[],
  ][])("rejects %s", (_name, operation, providers, codes) => {
    expect(
      diagnosticCodes([module("notifications", { operations: [operation], providers })]),
    ).toEqual(codes);
  });

  it("rejects effect dependencies hidden behind another provider", () => {
    expect(
      diagnosticCodes([
        module("notifications", {
          providers: [
            provider(emailEffectToken),
            provider(accountsToken, { email: emailEffectToken }),
          ],
        }),
      ]),
    ).toEqual(["SHIP_PROVIDER_EFFECT_FORBIDDEN"]);
  });

  it("projects the same graph regardless of declaration order", () => {
    const modules = validModules();
    const forward = compileApp({ id: "fixture-api", modules }).graph;
    const reversed = compileApp({ id: "fixture-api", modules: [...modules].reverse() }).graph;

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it.each([
    ["duplicate module id", [module("accounts"), module("accounts")], ["SHIP_MODULE_ID_DUPLICATE"]],
    [
      "missing imported module",
      [module("accounts", { imports: ["platform"] })],
      ["SHIP_MODULE_IMPORT_MISSING"],
    ],
    [
      "module import cycle",
      [
        module("accounts", { imports: ["platform"] }),
        module("platform", { imports: ["accounts"] }),
      ],
      ["SHIP_MODULE_IMPORT_CYCLE"],
    ],
    [
      "operation namespace mismatch",
      [module("accounts", { operations: [operation("health.read")] })],
      ["SHIP_MODULE_OPERATION_ID_MISMATCH"],
    ],
    [
      "duplicate operation id",
      [
        module("accounts", {
          operations: [operation("accounts.read"), operation("accounts.read")],
        }),
      ],
      ["SHIP_OPERATION_ID_DUPLICATE"],
    ],
    [
      "duplicate provider id",
      [module("platform", { providers: [provider(clockToken), provider(clockToken)] })],
      ["SHIP_PROVIDER_ID_DUPLICATE"],
    ],
    [
      "export not owned",
      [module("platform", { exports: [clockToken] })],
      ["SHIP_MODULE_EXPORT_NOT_OWNED"],
    ],
    [
      "missing provider",
      [module("accounts", { operations: [operation("accounts.read", { missing: missingToken })] })],
      ["SHIP_PROVIDER_MISSING"],
    ],
    [
      "required module import",
      [
        module("accounts", {
          operations: [operation("accounts.read", { clock: clockToken })],
        }),
        module("platform", { providers: [provider(clockToken)], exports: [clockToken] }),
      ],
      ["SHIP_MODULE_IMPORT_REQUIRED"],
    ],
    [
      "private provider use",
      [
        module("accounts", {
          operations: [operation("accounts.read", { clock: clockToken })],
          imports: ["platform"],
        }),
        module("platform", { providers: [provider(clockToken)] }),
      ],
      ["SHIP_PROVIDER_NOT_EXPORTED"],
    ],
    [
      "provider dependency cycle",
      [
        module("platform", {
          providers: [
            provider(clockToken, { accounts: accountsToken }),
            provider(accountsToken, { clock: clockToken }),
          ],
        }),
      ],
      ["SHIP_PROVIDER_DEPENDENCY_CYCLE"],
    ],
    [
      "transport collision",
      [
        module("accounts", {
          operations: [
            operation("accounts.read", {}, "GET /accounts/:id"),
            operation("accounts.list", {}, "GET /accounts/:id"),
          ],
        }),
      ],
      ["SHIP_TRANSPORT_BINDING_DUPLICATE"],
    ],
  ] satisfies readonly [
    string,
    readonly AnyModule[],
    readonly ApplicationDiagnosticCode[],
  ][])("reports %s", (_name, modules, expected) => {
    expect(diagnosticCodes(modules)).toEqual(expected);
  });

  it("aggregates and stably sorts independent failures", () => {
    const modules = [
      module("zeta", { imports: ["missing"] }),
      module("accounts", {
        operations: [operation("wrong.read", { missing: missingToken })],
      }),
    ];

    const first = diagnosticCodes(modules);
    const second = diagnosticCodes([...modules].reverse());

    expect(first).toEqual([
      "SHIP_MODULE_IMPORT_MISSING",
      "SHIP_MODULE_OPERATION_ID_MISMATCH",
      "SHIP_PROVIDER_MISSING",
    ]);
    expect(second).toEqual(first);
  });

  it("returns actionable diagnostic context", () => {
    try {
      compileApp({
        id: "fixture-api",
        modules: [
          module("accounts", {
            operations: [operation("accounts.read", { clock: clockToken })],
          }),
          module("platform", { providers: [provider(clockToken)], exports: [clockToken] }),
        ],
      });
      throw new Error("expected compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationCompilationError);
      expect(error).toMatchObject({
        diagnostics: [
          {
            code: "SHIP_MODULE_IMPORT_REQUIRED",
            severity: "error",
            moduleId: "accounts",
            operationId: "accounts.read",
            path: "dependencies.clock",
            hint: expect.stringContaining('Add "platform"'),
          },
        ],
      });
    }
  });

  it.each([
    [null, "SHIP_APP_DEFINITION_INVALID"],
    [{ id: "Bad App", modules: [] }, "SHIP_APP_ID_INVALID"],
    [{ id: "fixture-api", modules: [{}] }, "SHIP_APP_MODULE_INVALID"],
  ] satisfies readonly [
    unknown,
    ApplicationDiagnosticCode,
  ][])("rejects malformed application definition %#", (definition, code) => {
    const runtimeCompile = compileApp as (definition: unknown) => unknown;
    expect(() => runtimeCompile(definition)).toThrow(
      expect.objectContaining({ diagnostics: [expect.objectContaining({ code })] }),
    );
  });
});
