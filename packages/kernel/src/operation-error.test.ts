import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isOperationErrorDefinition,
  OperationFailure,
  operationError,
  operationFailure,
} from "./operation-error.js";

describe("operationError", () => {
  it("creates an immutable reusable error definition", () => {
    const error = operationError({
      code: "ACCOUNT_NOT_FOUND",
      status: 404,
      message: "Account not found",
      details: z.object({ accountId: z.string().uuid() }),
    });

    expect(error).toMatchObject({
      kind: "ship.operation-error",
      code: "ACCOUNT_NOT_FOUND",
      status: 404,
      message: "Account not found",
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(isOperationErrorDefinition(error)).toBe(true);
  });

  it.each([
    [{ code: "account.not-found", status: 404, message: "Missing" }, "code"],
    [{ code: "ACCOUNT_NOT_FOUND", status: 200, message: "Missing" }, "status"],
    [{ code: "ACCOUNT_NOT_FOUND", status: 404.5, message: "Missing" }, "status"],
    [{ code: "ACCOUNT_NOT_FOUND", status: 404, message: "" }, "message"],
    [{ code: "ACCOUNT_NOT_FOUND", status: 404, message: "Missing", details: {} }, "details"],
  ])("rejects an invalid %s definition", (definition) => {
    const runtimeDefine = operationError as (definition: unknown) => unknown;
    expect(() => runtimeDefine(definition)).toThrow(TypeError);
  });

  it("reserves framework error codes so application and transport failures cannot collide", () => {
    expect(() =>
      operationError({
        code: "VALIDATION_ERROR",
        status: 400,
        message: "Application validation failed",
      }),
    ).toThrow("reserved by the framework");
  });

  it("creates a throwable failure with safe defaults and an optional cause", () => {
    const cause = new Error("database detail");
    const error = operationError({ code: "CONFLICT", status: 409, message: "Already exists" });
    const failure = operationFailure(error, { message: "Name already exists", cause });

    expect(failure).toBeInstanceOf(OperationFailure);
    expect(failure).toMatchObject({
      name: "OperationFailure",
      code: "CONFLICT",
      message: "Name already exists",
      definition: error,
      cause,
    });
  });

  it("requires exactly the declared safe failure headers", () => {
    const limited = operationError({
      code: "RATE_LIMITED",
      status: 429,
      message: "Try again later",
      headers: ["Retry-After"] as const,
    });
    const failure = operationFailure(limited, { headers: { "Retry-After": "120" } });
    expect(failure.headers).toEqual({ "retry-after": "120" });
    expect(Object.isFrozen(limited.headers)).toBe(true);
    expect(Object.isFrozen(failure.headers)).toBe(true);

    const rawFailure = operationFailure as (definition: unknown, options?: unknown) => unknown;
    expect(() => rawFailure(limited)).toThrow("must match");
    expect(() => rawFailure(limited, { headers: { "X-Other": "120" } })).toThrow("must match");
    expect(() => rawFailure(limited, { headers: { "Retry-After": "0\r\nSet-Cookie: x" } })).toThrow(
      "must match",
    );
    expect(() => rawFailure(limited, { headers: { "Retry-After": "é" } })).toThrow("must match");
  });

  it.each([
    "Content-Type",
    "X-Request-Id",
    "Set-Cookie",
    "Access-Control-Allow-Origin",
  ])("rejects framework-owned failure header %s", (name) => {
    const rawDefine = operationError as (definition: unknown) => unknown;
    expect(() =>
      rawDefine({ code: "RATE_LIMITED", status: 429, message: "Later", headers: [name] }),
    ).toThrow("safe HTTP header names");
  });
});
