import { describe, expect, it } from "vitest";
import { dependency } from "./dependency.js";
import {
  defineProvider,
  InvalidProviderDefinitionError,
  isProvider,
  type ProviderDiagnosticCode,
  valueProvider,
} from "./provider.js";

const clockToken = dependency<{ now(): Date }>("platform.clock");
const repositoryToken = dependency<{ timestamp(): Date }>("accounts.repository");

function validDefinition() {
  return {
    token: repositoryToken,
    dependencies: { clock: clockToken },
    lifetime: "operation" as const,
    create: ({ services }: { services: { readonly clock: { now(): Date } } }) => ({
      timestamp: () => services.clock.now(),
    }),
  };
}

function defineUnknown(definition: unknown): unknown {
  const runtimeDefine = defineProvider as (value: unknown) => unknown;
  return runtimeDefine(definition);
}

function expectDiagnostic(definition: unknown, code: ProviderDiagnosticCode): void {
  expect(() => defineUnknown(definition)).toThrow(
    expect.objectContaining({ name: "InvalidProviderDefinitionError", code }),
  );
}

describe("defineProvider", () => {
  it("creates an immutable provider and dependency map", async () => {
    const definition = validDefinition();
    const provider = defineProvider(definition);
    const now = new Date("2026-09-03T00:00:00.000Z");

    expect(provider.kind).toBe("ship.provider");
    expect(provider.token).toBe(repositoryToken);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(Object.isFrozen(provider.dependencies)).toBe(true);
    expect(await provider.create({ services: { clock: { now: () => now } } })).toEqual({
      timestamp: expect.any(Function),
    });
    expect(isProvider(provider)).toBe(true);
  });

  it("creates a singleton value provider with no dependencies", async () => {
    const clock = { now: () => new Date("2026-09-03T00:00:00.000Z") };
    const provider = valueProvider(clockToken, clock);

    expect(provider.lifetime).toBe("singleton");
    expect(provider.dependencies).toEqual({});
    expect(await provider.create({ services: {} })).toBe(clock);
  });

  it.each([
    ["missing definition", null, "SHIP_PROVIDER_DEFINITION_INVALID"],
    ["invalid token", { ...validDefinition(), token: {} }, "SHIP_PROVIDER_TOKEN_INVALID"],
    [
      "invalid dependency map",
      { ...validDefinition(), dependencies: [] },
      "SHIP_PROVIDER_DEPENDENCY_INVALID",
    ],
    [
      "invalid dependency token",
      { ...validDefinition(), dependencies: { clock: {} } },
      "SHIP_PROVIDER_DEPENDENCY_INVALID",
    ],
    [
      "duplicate dependency token",
      { ...validDefinition(), dependencies: { clock: clockToken, duplicate: clockToken } },
      "SHIP_PROVIDER_DEPENDENCY_DUPLICATE",
    ],
    [
      "invalid lifetime",
      { ...validDefinition(), lifetime: "request" },
      "SHIP_PROVIDER_LIFETIME_INVALID",
    ],
    [
      "invalid factory",
      { ...validDefinition(), create: undefined },
      "SHIP_PROVIDER_FACTORY_INVALID",
    ],
  ] satisfies readonly [
    string,
    unknown,
    ProviderDiagnosticCode,
  ][])("rejects %s", (_name, definition, code) => {
    expectDiagnostic(definition, code);
  });

  it("attaches provider and field context to failures", () => {
    try {
      defineUnknown({ ...validDefinition(), lifetime: "request" });
      throw new Error("expected definition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProviderDefinitionError);
      expect(error).toMatchObject({
        code: "SHIP_PROVIDER_LIFETIME_INVALID",
        providerId: "accounts.repository",
        field: "lifetime",
      });
    }
  });
});
