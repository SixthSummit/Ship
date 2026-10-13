import type { AnyModule, CompiledApplication } from "@sixthsummit/ship-core";
import type { ClientContract, ClientContractError, ClientContractOperation } from "./project.js";
import { isWebhookTransport, projectClientContract } from "./project.js";
import {
  ContractProjectionError,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  stableJson,
} from "./schema.js";

export interface OpenApiProjectionOptions {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly serverUrls?: readonly string[];
}

export type OpenApiDocument = JsonObject & {
  readonly openapi: "3.1.0";
  readonly info: JsonObject;
  readonly paths: JsonObject;
};

export function projectOpenApi<
  const TApp extends CompiledApplication<string, readonly AnyModule[]>,
>(application: TApp, options: OpenApiProjectionOptions): OpenApiDocument {
  assertOptions(options);
  // The document fingerprint is the browser manifest's; webhooks are appended
  // as provider-facing paths without changing the client-visible contract.
  const contract = projectClientContract(application);
  const documented = projectClientContract(application, { includeWebhooks: true });
  const paths: Record<string, JsonValue> = {};
  const unbound: string[] = [];

  for (const operation of documented.operations) {
    if (operation.transport?.kind !== "http") {
      unbound.push(operation.id);
      continue;
    }
    const method = operation.transport.metadata?.method;
    const path = operation.transport.metadata?.path;
    if (typeof method !== "string" || typeof path !== "string") {
      throw new ContractProjectionError(
        "SHIP_CONTRACT_HTTP_REQUIRED",
        `operation ${JSON.stringify(operation.id)} has invalid HTTP metadata`,
        { operationId: operation.id, path: "transport.metadata" },
      );
    }
    const openApiPath = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, "{$1}");
    const pathItem = (paths[openApiPath] ?? {}) as Record<string, JsonValue>;
    pathItem[method.toLowerCase()] = isWebhookTransport(operation.transport)
      ? projectWebhookOperation(operation, contract)
      : projectHttpOperation(operation, contract);
    paths[openApiPath] = pathItem;
  }

  return stableJson({
    openapi: "3.1.0",
    info: {
      title: options.title,
      version: options.version,
      ...(options.description ? { description: options.description } : {}),
    },
    ...(options.serverUrls?.length ? { servers: options.serverUrls.map((url) => ({ url })) } : {}),
    paths,
    "x-ship-app-id": contract.appId,
    "x-ship-contract-fingerprint": contract.fingerprint,
    ...(unbound.length > 0 ? { "x-ship-unbound-operations": unbound.sort() } : {}),
  }) as OpenApiDocument;
}

function projectHttpOperation(
  operation: ClientContractOperation,
  contract: ClientContract,
): JsonObject {
  const parameters: JsonValue[] = [];
  let requestBody: JsonValue | undefined;
  const method = String(operation.transport?.metadata?.method);
  const rawPath = String(operation.transport?.metadata?.path);
  const responseMode = operation.transport?.metadata?.response;
  const contentType = operation.transport?.metadata?.contentType;
  const declaredContentTypes = operation.transport?.metadata?.contentTypes;
  const pathNames = new Set(
    [...rawPath.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]),
  );

  if (pathNames.size > 0 && !Object.hasOwn(operation.input, "params")) {
    throw new ContractProjectionError(
      "SHIP_CONTRACT_PATH_PARAMETER_MISMATCH",
      `path parameters and input.params properties differ for ${JSON.stringify(operation.id)}`,
      { operationId: operation.id, path: "input.params" },
    );
  }

  for (const [location, schema] of Object.entries(operation.input)) {
    if (location === "body") {
      if (method === "GET" || method === "OPTIONS") {
        throw new ContractProjectionError(
          "SHIP_CONTRACT_GET_BODY_UNSUPPORTED",
          `HTTP ${method} operation ${JSON.stringify(operation.id)} may not declare a request body`,
          { operationId: operation.id, path: "input.body" },
        );
      }
      requestBody = projectRequestBody(operation, schema.jsonSchema);
      continue;
    }
    if (location !== "params" && location !== "query" && location !== "headers") {
      throw new ContractProjectionError(
        "SHIP_CONTRACT_INPUT_LOCATION_UNSUPPORTED",
        `HTTP operation ${JSON.stringify(operation.id)} uses unsupported input location ${JSON.stringify(location)}`,
        { operationId: operation.id, path: `input.${location}` },
      );
    }
    parameters.push(...projectParameters(operation, location, schema.jsonSchema, rawPath));
  }

  const errorVariants = deduplicateErrors([...frameworkErrors(operation), ...operation.errors]);
  const responses: Record<string, JsonValue> = {};
  for (const success of operation.success) {
    if (operation.response?.mode === "stream") {
      responses[String(success.status)] = projectStreamResponse(operation.response, contentType);
      continue;
    }
    const successContentTypes =
      responseMode === "binary" && Array.isArray(declaredContentTypes)
        ? declaredContentTypes
        : [typeof contentType === "string" ? contentType : defaultContentType(responseMode)];
    const content =
      success.status === 204 || success.status === 205 || responseMode === "redirect"
        ? undefined
        : Object.fromEntries(
            successContentTypes.map((type) => [
              type,
              {
                schema:
                  responseMode === "binary"
                    ? { type: "string", format: "binary" }
                    : success.jsonSchema,
              },
            ]),
          );
    responses[String(success.status)] = {
      description: responseMode === "redirect" ? "Redirect" : "Successful response",
      ...(content ? { content } : {}),
      headers: {
        ...requestIdHeader(),
        ...cacheHeaders(operation),
        ...(responseMode === "redirect"
          ? { Location: { required: true, schema: { type: "string", format: "uri-reference" } } }
          : {}),
      },
    };
  }
  for (const status of [...new Set(errorVariants.map((error) => error.status))].sort()) {
    const variants = errorVariants.filter((error) => error.status === status);
    responses[String(status)] = {
      description: variants
        .map((error) => error.message)
        .sort()
        .join("; "),
      content: {
        "application/json": {
          schema:
            variants.length === 1
              ? errorEnvelopeSchema(variants[0])
              : { oneOf: variants.map(errorEnvelopeSchema) },
        },
      },
      headers: { ...requestIdHeader(), ...failureHeaders(variants) },
    };
  }

  return stableJson({
    operationId: operation.id,
    tags: [operation.id.split(".", 1)[0]],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
    "x-ship-access": operation.access as unknown as JsonValue,
    "x-ship-transaction": operation.transaction,
    ...(operation.transport?.metadata?.queryParsing
      ? { "x-ship-query-parsing": operation.transport.metadata.queryParsing }
      : {}),
    ...(operation.cache ? { "x-ship-cache": operation.cache as unknown as JsonValue } : {}),
    ...(operation.invalidates ? { "x-ship-invalidates": [...operation.invalidates] } : {}),
    "x-ship-contract-fingerprint": contract.fingerprint,
  });
}

function failureHeaders(variants: readonly ClientContractError[]): JsonObject {
  const names = new Map<string, string>();
  for (const variant of variants) {
    for (const name of variant.headers ?? []) names.set(name.toLowerCase(), name);
  }
  return Object.fromEntries(
    [...names]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([lower, name]) => [
        name,
        {
          required: variants.every((variant) =>
            variant.headers?.some((header) => header.toLowerCase() === lower),
          ),
          schema: { type: "string" },
        },
      ]),
  );
}

function projectStreamResponse(
  response: NonNullable<ClientContractOperation["response"]>,
  contentType: unknown,
): JsonObject {
  return {
    description:
      "Server-sent event stream: `frame` events validated by x-ship-stream-frame, ended by one `terminal` or `error` event",
    content: {
      [typeof contentType === "string" ? contentType : "text/event-stream; charset=utf-8"]: {
        schema: { type: "string", format: "event-stream" },
      },
    },
    headers: {
      ...requestIdHeader(),
      "X-Ship-Stream": {
        description: "Ship streaming wire protocol version",
        required: true,
        schema: { type: "string", const: "sse/1" },
      },
    },
    "x-ship-stream-framing": response.framing,
    "x-ship-stream-frame": response.frame.jsonSchema,
    ...(response.terminal ? { "x-ship-stream-terminal": response.terminal.jsonSchema } : {}),
    "x-ship-stream-limits": { ...response.limits },
  };
}

/**
 * Provider-facing webhook endpoint. Headers are provider-defined and the body
 * is opaque signed bytes, so no parameters are projected; the kernel's webhook
 * metadata is recorded under `x-ship-webhook` next to the raw body policy.
 */
function projectWebhookOperation(
  operation: ClientContractOperation,
  contract: ClientContract,
): JsonObject {
  const webhook = operation.transport?.metadata?.webhook;
  if (!isJsonObject(webhook)) {
    throw new ContractProjectionError(
      "SHIP_CONTRACT_HTTP_REQUIRED",
      `webhook operation ${JSON.stringify(operation.id)} has invalid webhook metadata`,
      { operationId: operation.id, path: "transport.metadata.webhook" },
    );
  }
  const inFlight = isJsonObject(webhook.idempotency) ? webhook.idempotency.inFlight : undefined;
  const inFlightStatus =
    isJsonObject(inFlight) && inFlight.kind === "retry" && typeof inFlight.status === "number"
      ? inFlight.status
      : 503;
  const errorVariants = deduplicateErrors([
    { code: "WEBHOOK_VERIFICATION_FAILED", status: 401, message: "Webhook verification failed" },
    {
      code: "WEBHOOK_IN_FLIGHT",
      status: inFlightStatus,
      message: "An identical delivery is still being processed",
    },
    { code: "PAYLOAD_TOO_LARGE", status: 413, message: "Request body is too large" },
    { code: "UNSUPPORTED_MEDIA_TYPE", status: 415, message: "Unsupported media type" },
    { code: "WEBHOOK_HANDLER_FAILED", status: 500, message: "Webhook processing failed" },
    { code: "INTERNAL_SERVER_ERROR", status: 500, message: "An unexpected error occurred" },
    {
      code: "WEBHOOK_UNAVAILABLE",
      status: 503,
      message: "Webhook receipt is temporarily unavailable",
    },
    {
      code: "WEBHOOK_SECRET_UNAVAILABLE",
      status: 503,
      message: "Webhook verification is temporarily unavailable",
    },
    ...operation.errors,
  ]);
  const responseMode = operation.transport?.metadata?.response;
  const contentType = operation.transport?.metadata?.contentType;
  const responses: Record<string, JsonValue> = {};
  for (const success of operation.success) {
    const bodiless = success.status === 204 || success.status === 205 || responseMode === "empty";
    responses[String(success.status)] = {
      description: bodiless ? "Delivery accepted; no response body" : "Delivery accepted",
      ...(bodiless
        ? {}
        : {
            content: {
              [typeof contentType === "string" ? contentType : defaultContentType(responseMode)]: {
                schema:
                  responseMode === "binary"
                    ? { type: "string", format: "binary" }
                    : responseMode === "text"
                      ? { type: "string" }
                      : success.jsonSchema,
              },
            },
          }),
      headers: requestIdHeader(),
    };
  }
  for (const status of [...new Set(errorVariants.map((error) => error.status))].sort()) {
    const variants = errorVariants.filter((error) => error.status === status);
    responses[String(status)] = {
      description: variants
        .map((error) => error.message)
        .sort()
        .join("; "),
      content: {
        "application/json": {
          schema:
            variants.length === 1
              ? errorEnvelopeSchema(variants[0])
              : { oneOf: variants.map(errorEnvelopeSchema) },
        },
      },
      headers: requestIdHeader(),
    };
  }
  return stableJson({
    operationId: operation.id,
    tags: [operation.id.split(".", 1)[0]],
    requestBody: projectRequestBody(operation, { type: "string", format: "binary" }),
    responses,
    "x-ship-access": operation.access as unknown as JsonValue,
    "x-ship-transaction": operation.transaction,
    "x-ship-contract-fingerprint": contract.fingerprint,
    "x-ship-webhook": webhook,
  });
}

function projectRequestBody(operation: ClientContractOperation, schema: JsonSchema): JsonObject {
  const policy = operation.transport?.metadata?.requestBody;
  if (isJsonObject(policy) && policy.mode === "raw") {
    const contentTypes = Array.isArray(policy.contentTypes)
      ? policy.contentTypes.filter((value): value is string => typeof value === "string")
      : [];
    return {
      required: true,
      content: Object.fromEntries(
        contentTypes.map((contentType) => [
          contentType,
          { schema: { type: "string", format: "binary" } },
        ]),
      ),
      "x-ship-request-body-policy": policy,
    };
  }
  const contentType =
    isJsonObject(policy) && policy.mode === "multipart"
      ? "multipart/form-data"
      : "application/json";
  return {
    required: true,
    content: { [contentType]: { schema } },
    ...(isJsonObject(policy) ? { "x-ship-request-body-policy": policy } : {}),
  };
}

function defaultContentType(responseMode: unknown): string {
  if (responseMode === "text") return "text/plain; charset=UTF-8";
  if (responseMode === "binary") return "application/octet-stream";
  if (responseMode === "stream") return "text/event-stream; charset=utf-8";
  return "application/json; charset=UTF-8";
}

function deduplicateErrors(errors: readonly ClientContractError[]): ClientContractError[] {
  return [
    ...new Map(errors.map((error) => [`${error.status}:${error.code}`, error] as const)).values(),
  ];
}

function projectParameters(
  operation: ClientContractOperation,
  location: "params" | "query" | "headers",
  schema: JsonSchema,
  rawPath: string,
): JsonValue[] {
  const properties = schema.properties;
  if (!isJsonObject(properties)) {
    throw new ContractProjectionError(
      "SHIP_CONTRACT_PARAMETER_SCHEMA_INVALID",
      `${location} schema for ${JSON.stringify(operation.id)} must be an object with properties`,
      { operationId: operation.id, path: `input.${location}` },
    );
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const pathNames = new Set(
    [...rawPath.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]),
  );
  if (
    location === "params" &&
    (pathNames.size !== Object.keys(properties).length ||
      Object.keys(properties).some((name) => !pathNames.has(name)))
  ) {
    throw new ContractProjectionError(
      "SHIP_CONTRACT_PATH_PARAMETER_MISMATCH",
      `path parameters and input.params properties differ for ${JSON.stringify(operation.id)}`,
      { operationId: operation.id, path: "input.params" },
    );
  }
  if (
    location === "headers" &&
    Object.keys(properties).some((name) => name !== name.toLowerCase())
  ) {
    throw new ContractProjectionError(
      "SHIP_CONTRACT_PARAMETER_SCHEMA_INVALID",
      `header schema keys must be lowercase for ${JSON.stringify(operation.id)}`,
      { operationId: operation.id, path: "input.headers" },
    );
  }
  const parameterLocation =
    location === "params" ? "path" : location === "headers" ? "header" : "query";
  return Object.entries(properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, property]) => ({
      name,
      in: parameterLocation,
      required: location === "params" || required.has(name),
      schema: property,
      ...(location === "query" && isArraySchema(property)
        ? { style: "form", explode: true, "x-ship-array-encoding": "brackets" }
        : {}),
    }));
}

function frameworkErrors(operation: ClientContractOperation): ClientContractError[] {
  const errors: ClientContractError[] = [];
  if (Object.keys(operation.input).length > 0) {
    errors.push({
      code: "VALIDATION_ERROR",
      status: 400,
      message: "Request validation failed",
      details: {
        vendor: "ship",
        jsonSchema: {
          type: "object",
          additionalProperties: true,
          required: ["issues"],
          properties: {
            issues: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                required: ["path", "message"],
                properties: {
                  path: { type: "array", items: { type: ["string", "number"] } },
                  code: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    });
  }
  if (operation.access.kind !== "public" && operation.access.kind !== "optional-identity") {
    errors.push({ code: "AUTHENTICATION_ERROR", status: 401, message: "Authentication failed" });
  }
  if (
    operation.access.kind === "permissions" ||
    operation.access.kind === "system" ||
    operation.access.kind === "provider"
  ) {
    errors.push({
      code: "AUTHORIZATION_ERROR",
      status: 403,
      message:
        operation.access.kind === "permissions"
          ? "Permission denied"
          : `Operation requires a ${operation.access.kind} actor`,
      details: {
        vendor: "ship",
        jsonSchema: {
          type: "object",
          additionalProperties: true,
          required: ["requiredPermissions"],
          properties: {
            requiredPermissions: { type: "array", items: { type: "string" } },
            requiredActorKind: { type: "string", enum: ["system", "provider"] },
          },
        },
      },
    });
  }
  if (operation.idempotency) {
    errors.push({
      code: "IDEMPOTENT_IN_FLIGHT",
      status: 409,
      message: "An identical request is still in flight",
      details: {
        vendor: "ship",
        jsonSchema: {
          type: "object",
          additionalProperties: true,
          required: ["idempotencyKey"],
          properties: { idempotencyKey: { type: "string" } },
        },
      },
    });
  }
  if (Object.hasOwn(operation.input, "body")) {
    errors.push(
      { code: "PAYLOAD_TOO_LARGE", status: 413, message: "Request body is too large" },
      { code: "UNSUPPORTED_MEDIA_TYPE", status: 415, message: "Unsupported media type" },
    );
  }
  errors.push({
    code: "INTERNAL_SERVER_ERROR",
    status: 500,
    message: "An unexpected error occurred",
  });
  return errors;
}

function errorEnvelopeSchema(error: ClientContractError): JsonSchema {
  return {
    type: "object",
    additionalProperties: true,
    required: ["success", "error"],
    properties: {
      success: { const: false },
      error: {
        type: "object",
        additionalProperties: true,
        required: ["code", "message"],
        properties: {
          code: { const: error.code },
          message: { type: "string" },
          ...(error.details ? { details: error.details.jsonSchema } : {}),
        },
      },
    },
  };
}

/**
 * A cached read documents both the declared Cache-Control a client may rely on
 * and the x-ship-cache observation that says whether this response was served
 * from the cache. Invalidation is eventual, so a client must treat max-age as
 * the staleness bound it accepts.
 */
function cacheHeaders(operation: ClientContractOperation): JsonObject {
  if (!operation.cache) return {};
  return {
    "Cache-Control": {
      description: "Declared caching policy for this operation",
      required: true,
      schema: { type: "string", const: operation.cache.cacheControl },
    },
    "X-Ship-Cache": {
      description: "Whether the executor served this response from its declared cache",
      required: true,
      schema: { type: "string", enum: ["hit", "miss"] },
    },
  };
}

function requestIdHeader(): JsonObject {
  return {
    "X-Request-Id": {
      description: "Stable request correlation identifier",
      required: true,
      schema: { type: "string" },
    },
  };
}

function isArraySchema(value: JsonValue): boolean {
  return isJsonObject(value) && value.type === "array";
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOptions(options: OpenApiProjectionOptions): void {
  if (!options.title?.trim() || !options.version?.trim()) {
    throw new TypeError("OpenAPI title and version must be non-empty strings");
  }
  if (options.serverUrls?.some((url) => !url.trim())) {
    throw new TypeError("OpenAPI server URLs must be non-empty strings");
  }
}
