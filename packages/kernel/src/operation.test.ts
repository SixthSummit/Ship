import { describe, expect, it } from "vitest";
import { z } from "zod";
import { permission, publicAccess } from "./access.js";
import { dependency, effectDependency } from "./dependency.js";
import {
  defineOperation,
  InvalidOperationDefinitionError,
  isExplicitOperationResponse,
  type OperationDefinitionDiagnosticCode,
  respond,
} from "./operation.js";
import { operationError } from "./operation-error.js";

const accountsRepository = dependency<{ find(id: string): Promise<{ id: string }> }>(
  "accounts.repository",
);
const accountNotFound = operationError({
  code: "ACCOUNT_NOT_FOUND",
  status: 404,
  message: "Account not found",
});
const emailEffect = effectDependency<{ send(): Promise<void> }>("email.send", {
  delivery: "immediate",
});

function validDefinition() {
  return {
    id: "accounts.get",
    input: { params: z.object({ accountId: z.string().uuid() }) },
    output: { 200: z.object({ id: z.string().uuid() }) },
    successStatus: 200,
    errors: [accountNotFound] as const,
    access: permission("accounts:read"),
    transaction: "read" as const,
    dependencies: { accounts: accountsRepository },
    transport: {
      kind: "http",
      binding: "GET /accounts/:accountId",
      metadata: { method: "GET", path: "/accounts/:accountId" },
    },
    handler: async ({ input, services }) => services.accounts.find(input.params.accountId),
  };
}

function defineUnknown(definition: unknown): unknown {
  const runtimeDefine = defineOperation as (value: unknown) => unknown;
  return runtimeDefine(definition);
}

function expectDiagnostic(definition: unknown, code: OperationDefinitionDiagnosticCode): void {
  expect(() => defineUnknown(definition)).toThrow(
    expect.objectContaining({ name: "InvalidOperationDefinitionError", code }),
  );
}

describe("defineOperation", () => {
  it("creates one immutable executable declaration without freezing vendor schemas", () => {
    const definition = validDefinition();
    const operation = defineOperation(definition);

    expect(operation.kind).toBe("ship.operation");
    expect(operation.id).toBe("accounts.get");
    expect(operation.handler).toBe(definition.handler);
    expect(operation.input.params).toBe(definition.input.params);
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.input)).toBe(true);
    expect(Object.isFrozen(operation.output)).toBe(true);
    expect(Object.isFrozen(operation.errors)).toBe(true);
    expect(Object.isFrozen(operation.dependencies)).toBe(true);
    expect(operation.effects).toEqual([]);
    expect(Object.isFrozen(operation.effects)).toBe(true);
    expect(Object.isFrozen(operation.transport)).toBe(true);
    expect(Object.isFrozen(operation.transport?.metadata)).toBe(true);
    expect(Object.isFrozen(operation.input.params)).toBe(false);
  });

  it("supports an empty input and dependency map", () => {
    const operation = defineOperation({
      id: "health.read",
      input: {},
      output: { 204: z.void() },
      successStatus: 204,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      handler: () => undefined,
    });

    expect(operation.successStatus).toBe(204);
  });

  it("copies and deeply freezes structured JSON transport metadata", () => {
    const requestBody = {
      mode: "raw",
      maxBytes: 4_096,
      contentTypes: ["application/octet-stream"],
    };
    const operation = defineOperation({
      ...validDefinition(),
      transport: {
        ...validDefinition().transport,
        metadata: { ...validDefinition().transport.metadata, requestBody },
      },
    });

    expect(operation.transport?.metadata?.requestBody).toEqual(requestBody);
    expect(operation.transport?.metadata?.requestBody).not.toBe(requestBody);
    expect(Object.isFrozen(operation.transport?.metadata?.requestBody)).toBe(true);
    expect(
      Object.isFrozen(
        (operation.transport?.metadata?.requestBody as { contentTypes: readonly string[] })
          .contentTypes,
      ),
    ).toBe(true);
  });

  it("rejects cyclic transport metadata before attempting to copy it", () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;

    expectDiagnostic(
      { ...validDefinition(), transport: { kind: "http", metadata } },
      "SHIP_OPERATION_TRANSPORT_INVALID",
    );
  });

  it.each([
    ["missing definition", null, "SHIP_OPERATION_DEFINITION_INVALID"],
    ["invalid id", { ...validDefinition(), id: "accounts" }, "SHIP_OPERATION_ID_INVALID"],
    [
      "invalid input map",
      { ...validDefinition(), input: { "not-valid": z.string() } },
      "SHIP_OPERATION_INPUT_INVALID",
    ],
    [
      "invalid input schema",
      { ...validDefinition(), input: { body: {} } },
      "SHIP_OPERATION_INPUT_INVALID",
    ],
    ["empty output", { ...validDefinition(), output: {} }, "SHIP_OPERATION_OUTPUT_INVALID"],
    [
      "non-success output",
      { ...validDefinition(), output: { 400: z.object({}) } },
      "SHIP_OPERATION_OUTPUT_INVALID",
    ],
    [
      "undeclared success status",
      { ...validDefinition(), successStatus: 201 },
      "SHIP_OPERATION_SUCCESS_STATUS_INVALID",
    ],
    [
      "malformed error code",
      { ...validDefinition(), errors: [{}] },
      "SHIP_OPERATION_ERROR_INVALID",
    ],
    [
      "duplicate error code",
      { ...validDefinition(), errors: [accountNotFound, accountNotFound] },
      "SHIP_OPERATION_ERROR_DUPLICATE",
    ],
    [
      "missing access",
      { ...validDefinition(), access: undefined },
      "SHIP_OPERATION_ACCESS_INVALID",
    ],
    [
      "invalid transaction",
      { ...validDefinition(), transaction: "ambient" },
      "SHIP_OPERATION_TRANSACTION_INVALID",
    ],
    [
      "invalid dependency",
      { ...validDefinition(), dependencies: { accounts: {} } },
      "SHIP_OPERATION_DEPENDENCY_INVALID",
    ],
    [
      "duplicate provider dependency",
      {
        ...validDefinition(),
        dependencies: { accounts: accountsRepository, duplicate: accountsRepository },
      },
      "SHIP_OPERATION_DEPENDENCY_DUPLICATE",
    ],
    [
      "invalid effect declaration",
      { ...validDefinition(), effects: [dependency("email.send")] },
      "SHIP_OPERATION_EFFECT_INVALID",
    ],
    [
      "duplicate effect declaration",
      { ...validDefinition(), effects: [emailEffect, emailEffect] },
      "SHIP_OPERATION_EFFECT_DUPLICATE",
    ],
    [
      "invalid transport",
      { ...validDefinition(), transport: { kind: "" } },
      "SHIP_OPERATION_TRANSPORT_INVALID",
    ],
    [
      "invalid transport metadata",
      { ...validDefinition(), transport: { kind: "http", metadata: { method: () => "GET" } } },
      "SHIP_OPERATION_TRANSPORT_INVALID",
    ],
    [
      "non-finite transport metadata",
      { ...validDefinition(), transport: { kind: "http", metadata: { maxBytes: Number.NaN } } },
      "SHIP_OPERATION_TRANSPORT_INVALID",
    ],
    [
      "non-JSON transport metadata",
      { ...validDefinition(), transport: { kind: "http", metadata: { createdAt: new Date() } } },
      "SHIP_OPERATION_TRANSPORT_INVALID",
    ],
    ["invalid handler", { ...validDefinition(), handler: null }, "SHIP_OPERATION_HANDLER_INVALID"],
  ] satisfies readonly [
    string,
    unknown,
    OperationDefinitionDiagnosticCode,
  ][])("rejects %s with %s", (_name, definition, code) => {
    expectDiagnostic(definition, code);
  });

  it("attaches operation and field context to definition failures", () => {
    try {
      defineUnknown({ ...validDefinition(), errors: [{}] });
      throw new Error("expected definition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidOperationDefinitionError);
      expect(error).toMatchObject({
        code: "SHIP_OPERATION_ERROR_INVALID",
        operationId: "accounts.get",
        field: "errors",
      });
    }
  });
});

describe("respond", () => {
  it("marks explicit alternate success results without adding wire metadata", () => {
    const response = respond(202, { queued: true });

    expect(response).toMatchObject({ status: 202, body: { queued: true } });
    expect(Object.keys(response)).toEqual(["status", "body"]);
    expect(Object.isFrozen(response)).toBe(true);
    expect(isExplicitOperationResponse(response)).toBe(true);
    expect(isExplicitOperationResponse({ status: 202, body: { queued: true } })).toBe(false);
  });

  it("normalizes and freezes explicitly declared response headers", () => {
    const response = respond(200, { ok: true }, { headers: { ETag: '"fixture-1"' } });

    expect(response.headers).toEqual({ etag: '"fixture-1"' });
    expect(Object.isFrozen(response.headers)).toBe(true);
  });

  it("rejects malformed or duplicate response headers from untyped handlers", () => {
    const runtimeRespond = respond as (status: number, body: unknown, options: unknown) => unknown;

    expect(() => runtimeRespond(200, {}, { headers: { "x-bad": "one\r\ntwo" } })).toThrow(
      TypeError,
    );
    expect(() => runtimeRespond(200, {}, { headers: { ETag: "one", etag: "two" } })).toThrow(
      TypeError,
    );
  });
});
