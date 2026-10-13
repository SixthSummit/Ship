import type {
  ClientContract,
  ClientContractOperation,
  ClientContractStreamResponse,
  ProjectedContractSchema,
} from "./manifest.js";
import { type OperationStreamHandle, openOperationStream } from "./stream.js";

const HTTP_INPUT_LOCATIONS = new Set(["params", "query", "headers", "body"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HTTP_RESPONSE_MODES = new Set(["json", "text", "binary", "stream", "redirect"]);
const STREAM_LIMIT_KEYS = ["heartbeatMs", "maxDurationMs", "maxFrames"] as const;
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const RESPONSE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const RESERVED_FAILURE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "keep-alive",
  "set-cookie",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-request-id",
  "x-ship-cache",
]);
const CODEC_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const FRAMEWORK_ERROR_STATUSES = new Map([
  ["VALIDATION_ERROR", 400],
  ["AUTHENTICATION_ERROR", 401],
  ["AUTHORIZATION_ERROR", 403],
  ["IDEMPOTENT_IN_FLIGHT", 409],
  ["PAYLOAD_TOO_LARGE", 413],
  ["UNSUPPORTED_MEDIA_TYPE", 415],
  ["INTERNAL_SERVER_ERROR", 500],
  ["AUTHENTICATION_UNAVAILABLE", 503],
]);

export interface ClientOperationType {
  readonly transport: string;
  readonly input: unknown;
  readonly result: { readonly ok: boolean; readonly status: number };
  /** Present for streaming operations: the decoded frame and terminal value types. */
  readonly stream?: { readonly frame: unknown; readonly terminal: unknown } | undefined;
}

export interface OperationTypeContract {
  readonly operations: Readonly<Record<string, ClientOperationType>>;
}

type OperationTypeFromContract<
  TContract extends OperationTypeContract,
  TId extends keyof TContract["operations"],
> = TContract["operations"][TId];

// Keep the four location checks explicit. A mapped Exclude<location, keyof input>
// makes TypeScript expand the full generated contract at call sites once the
// manifest reaches realistic application size (SAPI-429 / TS2590).
type OperationClientInput<TOperation extends ClientOperationType> =
  TOperation["input"] extends object
    ? TOperation["input"] & {
        readonly params?: "params" extends keyof TOperation["input"] ? unknown : never;
        readonly query?: "query" extends keyof TOperation["input"] ? unknown : never;
        readonly headers?: "headers" extends keyof TOperation["input"] ? unknown : never;
        readonly body?: "body" extends keyof TOperation["input"] ? unknown : never;
      }
    : TOperation["input"];

export type HttpOperationId<TContract extends OperationTypeContract> = Extract<
  {
    [TId in keyof TContract["operations"]]: OperationTypeFromContract<
      TContract,
      TId
    >["transport"] extends "http"
      ? TId
      : never;
  }[keyof TContract["operations"]],
  string
>;

export interface OperationResponseMetadata {
  readonly requestId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly retryAfter?: string;
  readonly etag?: string;
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly location?: string;
}

type WithClientMetadata<TResult> = TResult extends {
  readonly ok: true;
  readonly status: infer TStatus extends number;
  readonly data: infer TData;
}
  ? {
      readonly ok: true;
      readonly status: TStatus;
      readonly data: TData;
      readonly requestId: string;
      readonly metadata: OperationResponseMetadata;
    }
  : TResult extends {
        readonly ok: false;
        readonly status: infer TStatus extends number;
        readonly error: infer TError;
      }
    ? {
        readonly ok: false;
        readonly status: TStatus;
        readonly error: TError & { readonly requestId: string };
        readonly requestId: string;
        readonly metadata: OperationResponseMetadata;
      }
    : never;

type AdditionalFrameworkFailure =
  | {
      readonly ok: false;
      readonly status: 400;
      readonly error: {
        readonly code: "VALIDATION_ERROR";
        readonly message: string;
        readonly details?: {
          readonly issues: readonly {
            readonly path: readonly (string | number)[];
            readonly message: string;
            readonly code?: string;
          }[];
        };
      };
    }
  | {
      readonly ok: false;
      readonly status: 401;
      readonly error: { readonly code: "AUTHENTICATION_ERROR"; readonly message: string };
    }
  | {
      readonly ok: false;
      readonly status: 403;
      readonly error: {
        readonly code: "AUTHORIZATION_ERROR";
        readonly message: string;
        readonly details?: {
          readonly requiredPermissions: readonly string[];
          readonly requiredActorKind?: "system" | "provider";
        };
      };
    }
  | {
      readonly ok: false;
      readonly status: 409;
      readonly error: {
        readonly code: "IDEMPOTENT_IN_FLIGHT";
        readonly message: string;
        readonly details?: { readonly idempotencyKey: string };
      };
    }
  | {
      readonly ok: false;
      readonly status: 413;
      readonly error: { readonly code: "PAYLOAD_TOO_LARGE"; readonly message: string };
    }
  | {
      readonly ok: false;
      readonly status: 415;
      readonly error: { readonly code: "UNSUPPORTED_MEDIA_TYPE"; readonly message: string };
    }
  | {
      readonly ok: false;
      readonly status: 500;
      readonly error: { readonly code: "INTERNAL_SERVER_ERROR"; readonly message: string };
    }
  | {
      readonly ok: false;
      readonly status: 503;
      readonly error: { readonly code: "AUTHENTICATION_UNAVAILABLE"; readonly message: string };
    };

export type OperationClientResult<TOperation extends ClientOperationType> = WithClientMetadata<
  TOperation["result"] | AdditionalFrameworkFailure
>;

export interface OperationCallOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  /**
   * Forwarded verbatim to fetch's `RequestInit.keepalive` when set. Lets a
   * request outlive its page (for example a page-hide heartbeat). Browsers cap
   * the body of a keepalive request at 64 KiB; the client does not enforce
   * that limit. When omitted, no `keepalive` key is sent and the runtime
   * default applies.
   */
  readonly keepalive?: boolean;
}

/**
 * Unary operations resolve to a discriminated result; streaming operations
 * return an `OperationStreamHandle` synchronously.
 */
export type OperationCallResult<TOperation extends ClientOperationType> = TOperation extends {
  readonly stream: { readonly frame: infer TFrame; readonly terminal: infer TTerminal };
}
  ? OperationStreamHandle<TFrame, TTerminal>
  : Promise<OperationClientResult<TOperation>>;

export interface OperationClient<TContract extends OperationTypeContract> {
  call<TId extends HttpOperationId<TContract>>(
    operationId: TId,
    input: OperationClientInput<OperationTypeFromContract<TContract, TId>>,
    options?: OperationCallOptions,
  ): OperationCallResult<OperationTypeFromContract<TContract, TId>>;
}

/** Reuse this signature when adapting a client instead of redeclaring its generic call. */
export type OperationClientCall<TContract extends OperationTypeContract> =
  OperationClient<TContract>["call"];

export interface OperationClientCodec {
  readonly encode?: (value: unknown) => unknown | Promise<unknown>;
  readonly decode?: (value: unknown) => unknown | Promise<unknown>;
}

export interface CreateHttpOperationClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly credentials?: "omit" | "same-origin" | "include";
  readonly headers?: Readonly<Record<string, string>>;
  readonly codecs?: Readonly<Record<string, OperationClientCodec>>;
}

export type OperationClientDiagnosticCode =
  | "SHIP_CLIENT_CONTRACT_INVALID"
  | "SHIP_CLIENT_OPERATION_NOT_FOUND"
  | "SHIP_CLIENT_TRANSPORT_UNSUPPORTED"
  | "SHIP_CLIENT_INPUT_INVALID"
  | "SHIP_CLIENT_HEADER_INVALID"
  | "SHIP_CLIENT_QUERY_INVALID"
  | "SHIP_CLIENT_BODY_INVALID"
  | "SHIP_CLIENT_CODEC_MISSING"
  | "SHIP_CLIENT_CODEC_FAILED"
  | "SHIP_CLIENT_REDIRECT_OPAQUE"
  | "SHIP_CLIENT_RESPONSE_INVALID";

export class OperationClientError extends Error {
  readonly code: OperationClientDiagnosticCode;
  readonly operationId?: string;

  constructor(
    code: OperationClientDiagnosticCode,
    message: string,
    options: { readonly operationId?: string; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OperationClientError";
    this.code = code;
    this.operationId = options.operationId;
  }
}

export function createHttpOperationClient<TContract extends OperationTypeContract>(
  contract: ClientContract,
  options: CreateHttpOperationClientOptions,
): OperationClient<TContract> {
  assertContract(contract);
  assertBaseUrl(options.baseUrl);
  const operations = new Map(contract.operations.map((operation) => [operation.id, operation]));
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new OperationClientError(
      "SHIP_CLIENT_CONTRACT_INVALID",
      "createHttpOperationClient requires a fetch implementation",
    );
  }

  const prepareRequest = async (
    operation: ClientContractOperation,
    rawInput: unknown,
    callOptions: OperationCallOptions,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const operationId = operation.id;
    const metadata = operation.transport?.metadata;
    const method = metadata?.method;
    const path = metadata?.path;
    if (typeof method !== "string" || typeof path !== "string") {
      throw clientError(
        "SHIP_CLIENT_CONTRACT_INVALID",
        operationId,
        `operation ${JSON.stringify(operationId)} has invalid HTTP contract metadata`,
      );
    }
    const input = assertInput(rawInput, operation);
    const encoded = await encodeInput(input, operation, options.codecs);
    const pathname = interpolatePath(path, encoded.params, operationId);
    const query = serializeQuery(encoded.query, operationId);
    const headers = mergeHeaders(
      options.headers,
      encoded.headers,
      callOptions.headers,
      operationId,
    );
    if (callOptions.idempotencyKey !== undefined) {
      if (hasControlCharacter(callOptions.idempotencyKey)) {
        throw clientError(
          "SHIP_CLIENT_HEADER_INVALID",
          operationId,
          "idempotency key must be a safe header value",
        );
      }
      try {
        headers.set("idempotency-key", callOptions.idempotencyKey);
      } catch (cause) {
        throw clientError(
          "SHIP_CLIENT_HEADER_INVALID",
          operationId,
          "idempotency key is not accepted by this runtime",
          cause,
        );
      }
    }
    let body: RequestInit["body"] | undefined;
    if (Object.hasOwn(encoded, "body")) {
      body = serializeRequestBody(encoded.body, operation, headers);
    }
    if (operation.response?.mode === "stream") headers.set("accept", "text/event-stream");

    return fetchImplementation(`${trimBaseUrl(options.baseUrl)}${pathname}${query}`, {
      method,
      headers,
      ...(metadata?.response === "redirect" ? { redirect: "manual" as const } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
      ...(callOptions.keepalive !== undefined ? { keepalive: callOptions.keepalive } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
  };

  const callUnary = async (
    operation: ClientContractOperation,
    rawInput: unknown,
    callOptions: OperationCallOptions,
  ): Promise<unknown> => {
    const responseMode = operation.transport?.metadata?.response;
    if (
      responseMode !== "json" &&
      responseMode !== "text" &&
      responseMode !== "binary" &&
      responseMode !== "redirect"
    ) {
      throw clientError(
        "SHIP_CLIENT_CONTRACT_INVALID",
        operation.id,
        `operation ${JSON.stringify(operation.id)} has invalid HTTP contract metadata`,
      );
    }
    const response = await prepareRequest(operation, rawInput, callOptions, callOptions.signal);
    return readResponse(response, operation, responseMode, options.codecs);
  };

  const resolveOperation = (operationId: string): ClientContractOperation => {
    const operation = operations.get(operationId);
    if (!operation) {
      throw clientError(
        "SHIP_CLIENT_OPERATION_NOT_FOUND",
        operationId,
        `operation ${JSON.stringify(operationId)} is not present in contract ${JSON.stringify(contract.appId)}`,
      );
    }
    if (operation.transport?.kind !== "http") {
      throw clientError(
        "SHIP_CLIENT_TRANSPORT_UNSUPPORTED",
        operationId,
        `operation ${JSON.stringify(operationId)} does not declare an HTTP transport`,
      );
    }
    return operation;
  };

  const call = (
    operationId: string,
    rawInput: unknown,
    callOptions: OperationCallOptions = {},
  ): unknown => {
    const operation = operations.get(operationId);
    const streamResponse = operation?.response;
    if (operation?.transport?.kind === "http" && streamResponse?.mode === "stream") {
      return openOperationStream({
        operation,
        response: streamResponse,
        signal: callOptions.signal,
        send: (signal) => prepareRequest(operation, rawInput, callOptions, signal),
        decodeFrame: (value) =>
          runCodec("decode", streamResponse.frame, value, operationId, options.codecs),
        decodeTerminal: (value) =>
          runCodec(
            "decode",
            streamResponse.terminal ?? operation.success[0] ?? {},
            value,
            operationId,
            options.codecs,
          ),
      });
    }
    return Promise.resolve().then(() =>
      callUnary(resolveOperation(operationId), rawInput, callOptions),
    );
  };

  return Object.freeze({ call }) as unknown as OperationClient<TContract>;
}

function serializeRequestBody(
  value: unknown,
  operation: ClientContractOperation,
  headers: Headers,
): RequestInit["body"] {
  const policy = operation.transport?.metadata?.requestBody;
  const mode = isRecord(policy) ? policy.mode : "json";
  if (mode === "multipart") {
    if (!(value instanceof FormData)) {
      throw clientError(
        "SHIP_CLIENT_BODY_INVALID",
        operation.id,
        "multipart operation body must be FormData",
      );
    }
    if (headers.has("content-type")) {
      throw clientError(
        "SHIP_CLIENT_BODY_INVALID",
        operation.id,
        "multipart content-type must be generated by the fetch runtime so it includes a boundary",
      );
    }
    return value;
  }
  if (mode === "raw") {
    if (!isRawRequestBody(value)) {
      throw clientError(
        "SHIP_CLIENT_BODY_INVALID",
        operation.id,
        "raw operation body must be a string, Blob, ArrayBuffer, or byte view",
      );
    }
    const contentTypes = isRecord(policy) ? policy.contentTypes : undefined;
    if (!Array.isArray(contentTypes) || !contentTypes.every((item) => typeof item === "string")) {
      throw clientError(
        "SHIP_CLIENT_CONTRACT_INVALID",
        operation.id,
        "raw operation body policy must declare content types",
      );
    }
    const explicitContentType = headers.get("content-type");
    if (explicitContentType && !contentTypes.includes(mediaType(explicitContentType) ?? "")) {
      throw clientError(
        "SHIP_CLIENT_BODY_INVALID",
        operation.id,
        "raw operation content-type is not allowed by its contract",
      );
    }
    if (!explicitContentType) headers.set("content-type", contentTypes[0] as string);
    return value as RequestInit["body"];
  }

  let body: string | undefined;
  try {
    body = JSON.stringify(value);
  } catch (cause) {
    throw clientError(
      "SHIP_CLIENT_BODY_INVALID",
      operation.id,
      "operation body is not JSON serializable",
      cause,
    );
  }
  if (body === undefined) {
    throw clientError(
      "SHIP_CLIENT_BODY_INVALID",
      operation.id,
      "operation body is not JSON serializable",
    );
  }
  headers.set("content-type", "application/json; charset=UTF-8");
  return body;
}

function isRawRequestBody(value: unknown): boolean {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

async function encodeInput(
  input: Readonly<Record<string, unknown>>,
  operation: ClientContractOperation,
  codecs: CreateHttpOperationClientOptions["codecs"],
): Promise<Record<string, unknown>> {
  const encoded: Record<string, unknown> = {};
  for (const [location, value] of Object.entries(input)) {
    encoded[location] = await runCodec(
      "encode",
      operation.input[location],
      value,
      operation.id,
      codecs,
    );
  }
  return encoded;
}

async function readResponse(
  response: Response,
  operation: ClientContractOperation,
  responseMode: "json" | "text" | "binary" | "redirect",
  codecs: CreateHttpOperationClientOptions["codecs"],
): Promise<unknown> {
  if (responseMode === "redirect" && response.type === "opaqueredirect") {
    throw clientError(
      "SHIP_CLIENT_REDIRECT_OPAQUE",
      operation.id,
      `browser fetch cannot inspect the redirect for operation ${JSON.stringify(operation.id)}; navigate to the endpoint instead`,
    );
  }
  const metadata = responseMetadata(response.headers, operation.id);
  const requestId = metadata.requestId;
  const success = operation.success.find(({ status }) => status === response.status);
  if (success) {
    if (responseMode === "redirect") {
      if (
        !isSafeRedirectLocation(response.headers.get("location")) ||
        metadata.contentType ||
        (await response.text()) !== ""
      ) {
        throw clientError(
          "SHIP_CLIENT_RESPONSE_INVALID",
          operation.id,
          "redirect response must have a safe Location and no body",
        );
      }
    } else if (response.status !== 204 && response.status !== 205) {
      assertSuccessContentType(metadata.contentType, operation);
    }
    let data: unknown;
    try {
      data =
        response.status === 204 || response.status === 205 || responseMode === "redirect"
          ? undefined
          : responseMode === "json"
            ? await response.json()
            : responseMode === "text"
              ? await response.text()
              : new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      throw clientError(
        "SHIP_CLIENT_RESPONSE_INVALID",
        operation.id,
        `operation ${JSON.stringify(operation.id)} returned an unreadable success body`,
        cause,
      );
    }
    data = await runCodec("decode", success, data, operation.id, codecs);
    return Object.freeze({
      ok: true,
      status: response.status,
      data,
      requestId,
      metadata,
    });
  }

  if (!isJsonContentType(metadata.contentType)) {
    throw clientError(
      "SHIP_CLIENT_RESPONSE_INVALID",
      operation.id,
      `operation ${JSON.stringify(operation.id)} returned a failure without a JSON content type`,
    );
  }
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch (cause) {
    throw clientError(
      "SHIP_CLIENT_RESPONSE_INVALID",
      operation.id,
      `operation ${JSON.stringify(operation.id)} returned a non-JSON failure`,
      cause,
    );
  }
  if (!isErrorEnvelope(envelope)) {
    throw clientError(
      "SHIP_CLIENT_RESPONSE_INVALID",
      operation.id,
      `operation ${JSON.stringify(operation.id)} returned a malformed failure envelope`,
    );
  }
  const declared = operation.errors.find(
    ({ code, status }) => code === envelope.error.code && status === response.status,
  );
  if (!declared && FRAMEWORK_ERROR_STATUSES.get(envelope.error.code) !== response.status) {
    throw clientError(
      "SHIP_CLIENT_RESPONSE_INVALID",
      operation.id,
      `operation ${JSON.stringify(operation.id)} returned undeclared error ${JSON.stringify(envelope.error.code)}`,
    );
  }
  if (
    declared?.headers?.some(
      (name) => !isSafeDeclaredResponseHeaderValue(response.headers.get(name)),
    )
  ) {
    throw clientError(
      "SHIP_CLIENT_RESPONSE_INVALID",
      operation.id,
      `operation ${JSON.stringify(operation.id)} returned a failure without its declared headers`,
    );
  }
  const details = declared?.details
    ? await runCodec("decode", declared.details, envelope.error.details, operation.id, codecs)
    : envelope.error.details;
  return Object.freeze({
    ok: false,
    status: response.status,
    error: Object.freeze({
      ...envelope.error,
      ...(details !== undefined ? { details } : {}),
      requestId,
    }),
    requestId,
    metadata,
  });
}

function assertSuccessContentType(
  actualContentType: string | undefined,
  operation: ClientContractOperation,
): void {
  const expectedContentType = operation.transport?.metadata?.contentType;
  const declaredContentTypes = operation.transport?.metadata?.contentTypes;
  const allowed = Array.isArray(declaredContentTypes)
    ? declaredContentTypes
    : [expectedContentType];
  if (
    typeof expectedContentType !== "string" ||
    !allowed.some(
      (contentType) =>
        typeof contentType === "string" && mediaType(actualContentType) === mediaType(contentType),
    )
  ) {
    throw clientError(
      "SHIP_CLIENT_RESPONSE_INVALID",
      operation.id,
      `operation ${JSON.stringify(operation.id)} returned an unexpected success content type`,
    );
  }
}

function isJsonContentType(value: string | undefined): boolean {
  const type = mediaType(value);
  return (
    type === "application/json" ||
    Boolean(type?.startsWith("application/") && type.endsWith("+json"))
  );
}

function isSafeRedirectLocation(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return false;
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0].trim().toLowerCase() || undefined;
}

async function runCodec(
  direction: "encode" | "decode",
  schema: Pick<ProjectedContractSchema, "codec">,
  value: unknown,
  operationId: string,
  codecs: CreateHttpOperationClientOptions["codecs"],
): Promise<unknown> {
  if (!schema.codec) return value;
  const codec = codecs?.[schema.codec];
  if (!codec) {
    throw clientError(
      "SHIP_CLIENT_CODEC_MISSING",
      operationId,
      `operation ${JSON.stringify(operationId)} requires missing codec ${JSON.stringify(schema.codec)}`,
    );
  }
  const transform = codec[direction];
  if (!transform) return value;
  try {
    return await transform(value);
  } catch (cause) {
    throw clientError(
      "SHIP_CLIENT_CODEC_FAILED",
      operationId,
      `codec ${JSON.stringify(schema.codec)} failed to ${direction} ${JSON.stringify(operationId)}`,
      cause,
    );
  }
}

function assertInput(
  value: unknown,
  operation: ClientContractOperation,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw clientError(
      "SHIP_CLIENT_INPUT_INVALID",
      operation.id,
      "operation input must be an object",
    );
  }
  const input = value as Readonly<Record<string, unknown>>;
  for (const location of Object.keys(input)) {
    if (!HTTP_INPUT_LOCATIONS.has(location) || !Object.hasOwn(operation.input, location)) {
      throw clientError(
        "SHIP_CLIENT_INPUT_INVALID",
        operation.id,
        `operation input contains undeclared location ${JSON.stringify(location)}`,
      );
    }
  }
  for (const location of Object.keys(operation.input)) {
    if (!Object.hasOwn(input, location)) {
      throw clientError(
        "SHIP_CLIENT_INPUT_INVALID",
        operation.id,
        `operation input is missing location ${JSON.stringify(location)}`,
      );
    }
  }
  return input;
}

function interpolatePath(path: string, value: unknown, operationId: string): string {
  const params = asRecord(value);
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, name: string) => {
    const parameter = params?.[name];
    if (
      typeof parameter !== "string" &&
      typeof parameter !== "number" &&
      typeof parameter !== "boolean"
    ) {
      throw clientError(
        "SHIP_CLIENT_INPUT_INVALID",
        operationId,
        `path parameter ${JSON.stringify(name)} must be a string, number, or boolean`,
      );
    }
    if (parameter === "." || parameter === "..") {
      throw clientError(
        "SHIP_CLIENT_INPUT_INVALID",
        operationId,
        `path parameter ${JSON.stringify(name)} cannot be a dot-only URL segment`,
      );
    }
    return encodeURIComponent(String(parameter));
  });
}

function serializeQuery(value: unknown, operationId: string): string {
  if (value === undefined) return "";
  const query = asRecord(value);
  if (!query) {
    throw clientError("SHIP_CLIENT_QUERY_INVALID", operationId, "query input must be an object");
  }
  const components: string[] = [];
  for (const [name, item] of Object.entries(query).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (item === undefined) continue;
    const values = Array.isArray(item) ? item : [item];
    if (Array.isArray(item) && item.length === 0) {
      const marker = serializeQueryPair(`${name}[]`, "");
      components.push(marker.slice(0, -1));
      continue;
    }
    for (const entry of values) {
      if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
        throw clientError(
          "SHIP_CLIENT_QUERY_INVALID",
          operationId,
          `query value ${JSON.stringify(name)} must contain only strings, numbers, or booleans`,
        );
      }
      components.push(serializeQueryPair(Array.isArray(item) ? `${name}[]` : name, String(entry)));
    }
  }
  const serialized = components.join("&");
  return serialized ? `?${serialized}` : "";
}

function serializeQueryPair(name: string, value: string): string {
  const pair = new URLSearchParams();
  pair.append(name, value);
  return pair.toString();
}

function mergeHeaders(
  ...values: readonly [
    Readonly<Record<string, string>> | undefined,
    unknown,
    Readonly<Record<string, string>> | undefined,
    string,
  ]
): Headers {
  const [defaults, operationHeaders, callHeaders, operationId] = values;
  const headers = new Headers();
  for (const source of [defaults, asRecord(operationHeaders), callHeaders]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
        typeof value !== "string" ||
        /[\r\n]/u.test(value)
      ) {
        throw clientError(
          "SHIP_CLIENT_HEADER_INVALID",
          operationId,
          `header ${JSON.stringify(name)} must have a valid name and safe string value`,
        );
      }
      try {
        headers.set(name, value);
      } catch (cause) {
        throw clientError(
          "SHIP_CLIENT_HEADER_INVALID",
          operationId,
          `header ${JSON.stringify(name)} is not accepted by this runtime`,
          cause,
        );
      }
    }
  }
  return headers;
}

function responseMetadata(headers: Headers, operationId: string): OperationResponseMetadata {
  const all = Object.freeze(
    Object.fromEntries([...headers].sort(([left], [right]) => left.localeCompare(right))),
  );
  const requestId = headers.get("x-request-id");
  if (!requestId) {
    throw clientError(
      "SHIP_CLIENT_RESPONSE_INVALID",
      operationId,
      `operation ${JSON.stringify(operationId)} response is missing X-Request-Id`,
    );
  }
  return Object.freeze({
    requestId,
    headers: all,
    ...(headers.get("retry-after") ? { retryAfter: headers.get("retry-after") as string } : {}),
    ...(headers.get("etag") ? { etag: headers.get("etag") as string } : {}),
    ...(headers.get("content-type") ? { contentType: headers.get("content-type") as string } : {}),
    ...(headers.get("location") ? { location: headers.get("location") as string } : {}),
    ...(headers.get("content-disposition")
      ? { contentDisposition: headers.get("content-disposition") as string }
      : {}),
  });
}

function isErrorEnvelope(value: unknown): value is {
  readonly success: false;
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
} {
  if (typeof value !== "object" || value === null || Reflect.get(value, "success") !== false) {
    return false;
  }
  const error = Reflect.get(value, "error");
  return (
    typeof error === "object" &&
    error !== null &&
    typeof Reflect.get(error, "code") === "string" &&
    typeof Reflect.get(error, "message") === "string"
  );
}

function assertContract(contract: ClientContract): void {
  if (
    typeof contract !== "object" ||
    contract === null ||
    contract.schemaVersion !== 1 ||
    typeof contract.appId !== "string" ||
    contract.appId.length === 0 ||
    typeof contract.fingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(contract.fingerprint) ||
    !Array.isArray(contract.operations) ||
    (contract.channels !== undefined && !isRecord(contract.channels))
  ) {
    throw invalidContract("client contract must be a Ship client contract with schemaVersion 1");
  }

  const operationIds = new Set<string>();
  for (const operation of contract.operations) {
    if (
      !isRecord(operation) ||
      typeof operation.id !== "string" ||
      !OPERATION_ID_PATTERN.test(operation.id) ||
      operationIds.has(operation.id) ||
      !isRecord(operation.input) ||
      !Array.isArray(operation.success) ||
      operation.success.length === 0 ||
      !Array.isArray(operation.errors) ||
      (operation.transaction !== "none" &&
        operation.transaction !== "read" &&
        operation.transaction !== "write") ||
      (operation.publishes !== undefined && !Array.isArray(operation.publishes))
    ) {
      throw invalidContract("client contract contains an invalid or duplicate operation");
    }
    operationIds.add(operation.id);
    if (!Object.values(operation.input).every(isProjectedSchema)) {
      throw invalidContract("client contract contains an invalid input schema", operation.id);
    }

    const successStatuses = new Set<number>();
    for (const success of operation.success) {
      if (
        !isProjectedSchema(success) ||
        !Number.isInteger(success.status) ||
        success.status < 200 ||
        (operation.transport?.metadata?.response === "redirect" &&
          ![301, 302, 303, 307, 308].includes(success.status)) ||
        (operation.transport?.metadata?.response !== "redirect" && success.status > 299) ||
        successStatuses.has(success.status)
      ) {
        throw invalidContract(
          "client contract contains an invalid or duplicate success status",
          operation.id,
        );
      }
      successStatuses.add(success.status);
    }

    const errorCodes = new Set<string>();
    for (const error of operation.errors) {
      if (
        !isRecord(error) ||
        typeof error.code !== "string" ||
        !ERROR_CODE_PATTERN.test(error.code) ||
        errorCodes.has(error.code) ||
        typeof error.status !== "number" ||
        !Number.isInteger(error.status) ||
        error.status < 400 ||
        error.status > 599 ||
        typeof error.message !== "string" ||
        error.message.length === 0 ||
        (error.details !== undefined && !isProjectedSchema(error.details)) ||
        (error.headers !== undefined && !isDeclaredFailureHeaders(error.headers))
      ) {
        throw invalidContract(
          "client contract contains an invalid or duplicate error declaration",
          operation.id,
        );
      }
      errorCodes.add(error.code);
    }

    if (operation.transport !== undefined) assertContractTransport(operation);
    assertContractStreamResponse(operation);
  }
}

function isDeclaredFailureHeaders(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const names = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || !RESPONSE_HEADER_NAME.test(name)) return false;
    const lower = name.toLowerCase();
    if (RESERVED_FAILURE_HEADERS.has(lower) || lower.startsWith("access-control-")) return false;
    if (names.has(lower)) return false;
    names.add(lower);
  }
  return true;
}

function isSafeDeclaredResponseHeaderValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[\x20-\x7E]+$/u.test(value) &&
    value.trim() === value
  );
}

function assertContractStreamResponse(operation: ClientContractOperation): void {
  const response = operation.response;
  const declaredMode = isRecord(operation.transport?.metadata)
    ? operation.transport.metadata.response
    : undefined;
  if (response === undefined) {
    if (declaredMode === "stream") {
      throw invalidContract(
        "client contract stream operation is missing its response",
        operation.id,
      );
    }
    return;
  }
  if (!isStreamResponse(response) || declaredMode !== "stream") {
    throw invalidContract("client contract contains an invalid stream response", operation.id);
  }
}

function isStreamResponse(value: unknown): value is ClientContractStreamResponse {
  if (!isRecord(value) || value.mode !== "stream" || value.framing !== "sse") return false;
  if (!isProjectedSchema(value.frame)) return false;
  if (value.terminal !== undefined && !isProjectedSchema(value.terminal)) return false;
  const limits = value.limits;
  return (
    isRecord(limits) &&
    hasOnlyKeys(limits, STREAM_LIMIT_KEYS) &&
    STREAM_LIMIT_KEYS.every((key) => isPositiveSafeInteger(limits[key]))
  );
}

function assertContractTransport(operation: ClientContractOperation): void {
  const transport = operation.transport;
  if (!isRecord(transport) || typeof transport.kind !== "string" || transport.kind.length === 0) {
    throw invalidContract("client contract contains an invalid transport", operation.id);
  }
  if (transport.kind !== "http") return;
  const metadata = transport.metadata;
  const method = isRecord(metadata) ? metadata.method : undefined;
  const requestBody = isRecord(metadata) ? metadata.requestBody : undefined;
  const contentTypes = isRecord(metadata) ? metadata.contentTypes : undefined;
  const declaresBody = Object.hasOwn(operation.input, "body");
  if (
    !isRecord(metadata) ||
    typeof method !== "string" ||
    !HTTP_METHODS.has(method) ||
    typeof metadata.path !== "string" ||
    !metadata.path.startsWith("/") ||
    typeof metadata.response !== "string" ||
    !HTTP_RESPONSE_MODES.has(metadata.response) ||
    (metadata.queryParsing !== undefined &&
      metadata.queryParsing !== "strict" &&
      metadata.queryParsing !== "first-value" &&
      metadata.queryParsing !== "literal-keys") ||
    (metadata.response === "redirect"
      ? metadata.contentType !== undefined
      : typeof metadata.contentType !== "string" || metadata.contentType.length === 0) ||
    !isResponseContentTypes(contentTypes, metadata.response, metadata.contentType) ||
    Object.keys(operation.input).some((location) => !HTTP_INPUT_LOCATIONS.has(location)) ||
    !isRequestBodyPolicy(requestBody) ||
    (declaresBody && (method === "GET" || method === "OPTIONS")) ||
    (!declaresBody &&
      isRecord(requestBody) &&
      (requestBody.mode !== "json" ||
        requestBody.maxBytes !== undefined ||
        requestBody.onNonJsonContentType !== undefined ||
        requestBody.onInvalidJson !== undefined ||
        requestBody.onEmptyJsonBody !== undefined))
  ) {
    throw invalidContract("client contract contains invalid HTTP metadata", operation.id);
  }
}

function isResponseContentTypes(value: unknown, response: unknown, primary: unknown): boolean {
  if (value === undefined) return true;
  return (
    response === "binary" &&
    Array.isArray(value) &&
    value.length >= 2 &&
    value[0] === primary &&
    value.every(
      (contentType) =>
        typeof contentType === "string" &&
        /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+(?:\s*;[^\r\n]+)*$/iu.test(contentType),
    ) &&
    new Set(value.map((contentType: string) => contentType.toLowerCase())).size === value.length
  );
}

function isRequestBodyPolicy(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.mode === "json") {
    const onNonJsonContentType = value.onNonJsonContentType;
    const onInvalidJson = value.onInvalidJson;
    const onEmptyJsonBody = value.onEmptyJsonBody;
    return (
      hasOnlyKeys(value, [
        "mode",
        "maxBytes",
        "onNonJsonContentType",
        "onInvalidJson",
        "onEmptyJsonBody",
      ]) &&
      (value.maxBytes === undefined || isPositiveSafeInteger(value.maxBytes)) &&
      (onNonJsonContentType === undefined ||
        onNonJsonContentType === "reject" ||
        onNonJsonContentType === "ignore") &&
      (onInvalidJson === undefined || onInvalidJson === "reject" || onInvalidJson === "ignore") &&
      (onEmptyJsonBody === undefined ||
        onEmptyJsonBody === "reject" ||
        onEmptyJsonBody === "ignore")
    );
  }
  if (value.mode === "raw") {
    const contentTypes = value.contentTypes;
    return (
      hasOnlyKeys(value, ["mode", "maxBytes", "contentTypes"]) &&
      isPositiveSafeInteger(value.maxBytes) &&
      Array.isArray(contentTypes) &&
      contentTypes.length > 0 &&
      contentTypes.every(
        (contentType, index) =>
          typeof contentType === "string" &&
          /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(contentType) &&
          contentTypes.indexOf(contentType) === index,
      )
    );
  }
  return (
    value.mode === "multipart" &&
    hasOnlyKeys(value, [
      "mode",
      "maxBytes",
      "maxFiles",
      "maxFileBytes",
      "maxFields",
      "maxFieldBytes",
    ]) &&
    isPositiveSafeInteger(value.maxBytes) &&
    isNonNegativeSafeInteger(value.maxFiles) &&
    isPositiveSafeInteger(value.maxFileBytes) &&
    value.maxFileBytes <= value.maxBytes &&
    isNonNegativeSafeInteger(value.maxFields) &&
    value.maxFiles + value.maxFields > 0 &&
    isPositiveSafeInteger(value.maxFieldBytes) &&
    value.maxFieldBytes <= value.maxBytes
  );
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isProjectedSchema<TValue>(value: TValue): value is TValue & ProjectedContractSchema {
  return (
    isRecord(value) &&
    typeof value.vendor === "string" &&
    value.vendor.length > 0 &&
    isRecord(value.jsonSchema) &&
    (value.codec === undefined ||
      (typeof value.codec === "string" && CODEC_ID_PATTERN.test(value.codec)))
  );
}

function invalidContract(message: string, operationId?: string): OperationClientError {
  return new OperationClientError("SHIP_CLIENT_CONTRACT_INVALID", message, { operationId });
}

function assertBaseUrl(value: string): void {
  if (typeof value !== "string" || value.length === 0 || /[?#]/u.test(value)) {
    throw new OperationClientError(
      "SHIP_CLIENT_CONTRACT_INVALID",
      "client baseUrl must be a non-empty URL without query or fragment",
    );
  }
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function isRecord<TValue>(value: TValue): value is TValue & Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint <= 31 || codePoint === 127;
  });
}

function clientError(
  code: OperationClientDiagnosticCode,
  operationId: string,
  message: string,
  cause?: unknown,
): OperationClientError {
  return new OperationClientError(code, message, { operationId, cause });
}
