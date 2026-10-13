import { describe, expect, it } from "vitest";
import {
  dependency,
  effectDependency,
  isDependencyToken,
  isEffectDependencyToken,
  isUnitOfWork,
  isUnitOfWorkDependencyToken,
  unitOfWorkDependency,
} from "./dependency.js";

describe("dependency", () => {
  it("creates an immutable stable provider token", () => {
    const token = dependency<{ find(id: string): unknown }>("accounts.repository");

    expect(token).toEqual({ kind: "ship.dependency", id: "accounts.repository" });
    expect(Object.isFrozen(token)).toBe(true);
    expect(isDependencyToken(token)).toBe(true);
  });

  it.each([
    "",
    "Accounts.Repository",
    "accounts/repository",
    ".accounts",
  ])("rejects invalid id %j", (id) => {
    expect(() => dependency(id)).toThrow(TypeError);
  });

  it("rejects token-shaped objects with invalid ids", () => {
    expect(isDependencyToken({ kind: "ship.dependency", id: "Accounts.Repository" })).toBe(false);
    expect(isDependencyToken({ kind: "something-else", id: "accounts.repository" })).toBe(false);
    expect(
      isDependencyToken({ kind: "ship.dependency", id: "accounts.repository", scope: "request" }),
    ).toBe(false);
  });

  it("creates a distinct transaction-scoped dependency token", () => {
    const token = unitOfWorkDependency<{ readonly accounts: unknown }>("database.primary");

    expect(token).toEqual({
      kind: "ship.dependency",
      id: "database.primary",
      scope: "unit-of-work",
    });
    expect(isDependencyToken(token)).toBe(true);
    expect(isUnitOfWorkDependencyToken(token)).toBe(true);
    expect(isUnitOfWorkDependencyToken(dependency("database.primary"))).toBe(false);
  });

  it("creates a distinct immediate external-effect dependency", () => {
    const token = effectDependency<{ send(message: string): Promise<void> }>("email.send", {
      delivery: "immediate",
    });

    expect(token).toEqual({
      kind: "ship.dependency",
      id: "email.send",
      scope: "effect",
      delivery: "immediate",
    });
    expect(isDependencyToken(token)).toBe(true);
    expect(isEffectDependencyToken(token)).toBe(true);
    expect(isEffectDependencyToken(dependency("email.send"))).toBe(false);
  });

  it("rejects malformed effect delivery metadata", () => {
    const runtimeEffect = effectDependency as (id: string, options: unknown) => unknown;

    expect(() => runtimeEffect("email.send", { delivery: "after-commit" })).toThrow(TypeError);
    expect(
      isDependencyToken({
        kind: "ship.dependency",
        id: "email.send",
        scope: "effect",
      }),
    ).toBe(false);
    expect(
      isDependencyToken({
        kind: "ship.dependency",
        id: "email.send",
        delivery: "immediate",
      }),
    ).toBe(false);
  });

  it("recognizes only named unit-of-work controllers", () => {
    expect(isUnitOfWork({ kind: "ship.unit-of-work", id: "database.primary", run() {} })).toBe(
      true,
    );
    expect(isUnitOfWork({ kind: "ship.unit-of-work", id: "Bad ID", run() {} })).toBe(false);
    expect(isUnitOfWork({ kind: "ship.unit-of-work", id: "database.primary" })).toBe(false);
  });
});
