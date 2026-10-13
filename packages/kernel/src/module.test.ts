import { describe, expect, it } from "vitest";
import { z } from "zod";
import { publicAccess } from "./access.js";
import { dependency } from "./dependency.js";
import {
  defineModule,
  InvalidModuleDefinitionError,
  isShipModule,
  type ModuleDiagnosticCode,
} from "./module.js";
import { defineOperation } from "./operation.js";
import { defineProvider } from "./provider.js";

const clockToken = dependency<{ now(): Date }>("platform.clock");
const clockProvider = defineProvider({
  token: clockToken,
  dependencies: {},
  lifetime: "singleton",
  create: () => ({ now: () => new Date("2026-09-03T00:00:00.000Z") }),
});
const healthOperation = defineOperation({
  id: "health.read",
  input: {},
  output: { 200: z.object({ status: z.literal("ok") }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: { clock: clockToken },
  handler: () => ({ status: "ok" as const }),
});

function validDefinition() {
  return {
    id: "health",
    operations: [healthOperation] as const,
    providers: [clockProvider] as const,
    imports: [] as const,
    exports: [clockToken] as const,
  };
}

function defineUnknown(definition: unknown): unknown {
  const runtimeDefine = defineModule as (value: unknown) => unknown;
  return runtimeDefine(definition);
}

function expectDiagnostic(definition: unknown, code: ModuleDiagnosticCode): void {
  expect(() => defineUnknown(definition)).toThrow(
    expect.objectContaining({ name: "InvalidModuleDefinitionError", code }),
  );
}

describe("defineModule", () => {
  it("creates an immutable module without mutating its graph nodes", () => {
    const definition = validDefinition();
    const module = defineModule(definition);

    expect(module.kind).toBe("ship.module");
    expect(module.id).toBe("health");
    expect(module.operations[0]).toBe(healthOperation);
    expect(module.providers[0]).toBe(clockProvider);
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module.operations)).toBe(true);
    expect(Object.isFrozen(module.providers)).toBe(true);
    expect(Object.isFrozen(module.imports)).toBe(true);
    expect(Object.isFrozen(module.exports)).toBe(true);
    expect(isShipModule(module)).toBe(true);
  });

  it("allows provider-only and operation-only modules", () => {
    expect(
      defineModule({
        id: "platform",
        operations: [],
        providers: [clockProvider],
        imports: [],
        exports: [clockToken],
      }),
    ).toBeDefined();
    expect(
      defineModule({
        id: "health",
        operations: [healthOperation],
        providers: [],
        imports: ["platform"],
        exports: [],
      }),
    ).toBeDefined();
  });

  it.each([
    ["missing definition", null, "SHIP_MODULE_DEFINITION_INVALID"],
    ["invalid id", { ...validDefinition(), id: "Health/API" }, "SHIP_MODULE_ID_INVALID"],
    [
      "invalid operation",
      { ...validDefinition(), operations: [{}] },
      "SHIP_MODULE_OPERATION_INVALID",
    ],
    ["invalid provider", { ...validDefinition(), providers: [{}] }, "SHIP_MODULE_PROVIDER_INVALID"],
    ["invalid import", { ...validDefinition(), imports: [""] }, "SHIP_MODULE_IMPORT_INVALID"],
    [
      "duplicate import",
      { ...validDefinition(), imports: ["platform", "platform"] },
      "SHIP_MODULE_IMPORT_DUPLICATE",
    ],
    ["self import", { ...validDefinition(), imports: ["health"] }, "SHIP_MODULE_SELF_IMPORT"],
    ["invalid export", { ...validDefinition(), exports: [{}] }, "SHIP_MODULE_EXPORT_INVALID"],
    [
      "duplicate export",
      { ...validDefinition(), exports: [clockToken, clockToken] },
      "SHIP_MODULE_EXPORT_DUPLICATE",
    ],
  ] satisfies readonly [
    string,
    unknown,
    ModuleDiagnosticCode,
  ][])("rejects %s", (_name, definition, code) => {
    expectDiagnostic(definition, code);
  });

  it("attaches module and field context to failures", () => {
    try {
      defineUnknown({ ...validDefinition(), imports: ["health"] });
      throw new Error("expected definition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidModuleDefinitionError);
      expect(error).toMatchObject({
        code: "SHIP_MODULE_SELF_IMPORT",
        moduleId: "health",
        field: "imports",
      });
    }
  });
});
