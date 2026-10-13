import type {
  OperationStreamResponse,
  OperationTransport,
  RuntimeSchema,
} from "@sixthsummit/ship-core";
import { isOperationStreamResponse } from "@sixthsummit/ship-core";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export type HttpUnaryResponseMode = "json" | "text" | "binary" | "redirect";
/**
 * `empty` is never declared through `http.*`; it is compiled only by kernel
 * webhook transports (`defineWebhook({ response: { mode: "empty" } })`) and
 * answers the success status with no entity body and no content type.
 */
export type HttpResponseMode = HttpUnaryResponseMode | "stream" | "empty";
/** How repeated query keys are presented to the operation input schema. */
export type HttpQueryParsing = "strict" | "first-value" | "literal-keys";
export type HttpStreamFraming = "sse";
export const HTTP_STREAM_CONTENT_TYPE = "text/event-stream; charset=utf-8";

/**
 * Streaming response declaration for an HTTP operation. Frames are validated
 * against `frame`; the terminal value is the operation's declared `200` output.
 */
export interface HttpStreamResponse<TFrame extends RuntimeSchema = RuntimeSchema>
  extends OperationStreamResponse<TFrame> {
  readonly framing: HttpStreamFraming;
}

export type HttpResponseDeclaration = HttpUnaryResponseMode | HttpStreamResponse;
export type HttpResponseModeOf<TResponse extends HttpResponseDeclaration> =
  TResponse extends HttpStreamResponse ? "stream" : TResponse;

export type HttpJsonBodyPolicy = Readonly<{
  readonly mode: "json";
  readonly maxBytes?: number;
  /** Migration opt-in: treat a non-JSON body as absent instead of returning 415. */
  readonly onNonJsonContentType?: "reject" | "ignore";
  /** Migration opt-in: treat malformed UTF-8/JSON as absent instead of returning 400. */
  readonly onInvalidJson?: "reject" | "ignore";
  /** Migration opt-in: reject a zero-byte JSON request after authorization. */
  readonly onEmptyJsonBody?: "reject" | "ignore";
}>;

export type HttpRawBodyPolicy = Readonly<{
  readonly mode: "raw";
  readonly maxBytes: number;
  readonly contentTypes: readonly string[];
}>;

export type HttpMultipartBodyPolicy = Readonly<{
  readonly mode: "multipart";
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxFields: number;
  readonly maxFieldBytes: number;
}>;

export type HttpRequestBodyPolicy =
  | HttpJsonBodyPolicy
  | HttpRawBodyPolicy
  | HttpMultipartBodyPolicy;

export interface HttpMultipartBodyOptions {
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly maxFiles?: number;
  readonly maxFields?: number;
  readonly maxFieldBytes?: number;
}

export interface HttpRawBodyOptions {
  readonly maxBytes: number;
  readonly contentTypes?: readonly string[];
}

export interface HttpTransportOptions<
  TResponse extends HttpResponseDeclaration = HttpResponseDeclaration,
> {
  readonly response?: TResponse;
  /** Unary representations only; streams always use text/event-stream. */
  readonly contentType?: TResponse extends HttpStreamResponse ? never : string;
  /** Binary downloads may choose one of these declared types through respond() headers. */
  readonly contentTypes?: TResponse extends "binary" ? readonly string[] : never;
  readonly requestBody?: HttpRequestBodyPolicy;
  /** Select first values or literal repeated-key parsing; strict bracket parsing is the default. */
  readonly queryParsing?: HttpQueryParsing;
}

export interface HttpTransportBase<
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TResponse extends HttpResponseDeclaration = HttpResponseDeclaration,
> extends OperationTransport {
  readonly kind: "http";
  readonly binding: `${TMethod} ${TPath}`;
  readonly metadata: Readonly<{
    method: TMethod;
    path: TPath;
    response: HttpResponseModeOf<TResponse>;
    contentType?: string;
    contentTypes?: readonly string[];
    requestBody: HttpRequestBodyPolicy;
    queryParsing?: HttpQueryParsing;
  }>;
}

export type HttpTransport<
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TResponse extends HttpResponseDeclaration = HttpResponseDeclaration,
> = HttpTransportBase<TMethod, TPath, TResponse> &
  (TResponse extends HttpStreamResponse
    ? { readonly response: TResponse }
    : { readonly response?: undefined });

export class InvalidHttpTransportError extends TypeError {
  readonly code = "SHIP_HTTP_TRANSPORT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "InvalidHttpTransportError";
  }
}

function defineHttpTransport<
  const TMethod extends HttpMethod,
  const TPath extends string,
  const TResponse extends HttpResponseDeclaration = "json",
>(
  method: TMethod,
  path: TPath,
  options: HttpTransportOptions<TResponse> = {},
): HttpTransport<TMethod, TPath, TResponse> {
  if (!isHttpMethod(method)) {
    throw new InvalidHttpTransportError(`unsupported HTTP method ${JSON.stringify(method)}`);
  }
  assertHttpPath(path);
  const declaration: unknown = options.response ?? "json";
  const requestBody = normalizeRequestBodyPolicy(options.requestBody);
  if (options.queryParsing !== undefined && !isHttpQueryParsing(options.queryParsing)) {
    throw new InvalidHttpTransportError(
      `unsupported HTTP query parsing mode ${JSON.stringify(options.queryParsing)}`,
    );
  }
  const queryParsing = options.queryParsing;
  if (isHttpStreamResponse(declaration)) {
    if (options.contentType !== undefined || options.contentTypes !== undefined) {
      throw new InvalidHttpTransportError(
        "streaming HTTP responses always use text/event-stream; remove contentType/contentTypes",
      );
    }
    const metadata = Object.freeze({
      method,
      path,
      response: "stream" as const,
      contentType: HTTP_STREAM_CONTENT_TYPE,
      requestBody,
      ...(queryParsing ? { queryParsing } : {}),
    });
    return Object.freeze({
      kind: "http" as const,
      binding: `${method} ${path}` as const,
      metadata,
      response: Object.freeze({ ...declaration }),
    }) as unknown as HttpTransport<TMethod, TPath, TResponse>;
  }
  if (!isHttpUnaryResponseMode(declaration)) {
    throw new InvalidHttpTransportError(
      `unsupported HTTP response mode ${JSON.stringify(declaration)}`,
    );
  }
  if (declaration === "redirect") {
    if (options.contentType !== undefined || options.contentTypes !== undefined) {
      throw new InvalidHttpTransportError("redirect responses cannot declare a content type");
    }
    return Object.freeze({
      kind: "http" as const,
      binding: `${method} ${path}` as const,
      metadata: Object.freeze({
        method,
        path,
        response: declaration,
        requestBody,
        ...(queryParsing ? { queryParsing } : {}),
      }),
    }) as unknown as HttpTransport<TMethod, TPath, TResponse>;
  }
  if (options.contentTypes !== undefined) {
    const choices = options.contentTypes;
    if (
      declaration !== "binary" ||
      options.contentType !== undefined ||
      !Array.isArray(choices) ||
      choices.length < 2 ||
      !choices.every((value) => isContentType(value)) ||
      new Set(choices.map((value) => value.toLowerCase())).size !== choices.length
    ) {
      throw new InvalidHttpTransportError(
        "contentTypes requires at least two distinct binary response content types and no contentType",
      );
    }
    const contentTypes = Object.freeze([...choices]);
    return Object.freeze({
      kind: "http" as const,
      binding: `${method} ${path}` as const,
      metadata: Object.freeze({
        method,
        path,
        response: declaration,
        contentType: contentTypes[0]!,
        contentTypes,
        requestBody,
        ...(queryParsing ? { queryParsing } : {}),
      }),
    }) as unknown as HttpTransport<TMethod, TPath, TResponse>;
  }
  const contentType = options.contentType ?? defaultContentType(declaration);
  if (!isContentType(contentType)) {
    throw new InvalidHttpTransportError(`invalid HTTP content type ${JSON.stringify(contentType)}`);
  }
  const metadata = Object.freeze({
    method,
    path,
    response: declaration,
    contentType,
    requestBody,
    ...(queryParsing ? { queryParsing } : {}),
  });
  return Object.freeze({
    kind: "http" as const,
    binding: `${method} ${path}` as const,
    metadata,
  }) as unknown as HttpTransport<TMethod, TPath, TResponse>;
}

export const http = Object.freeze({
  body: Object.freeze({
    json: (
      options: {
        readonly maxBytes?: number;
        readonly onNonJsonContentType?: "reject" | "ignore";
        readonly onInvalidJson?: "reject" | "ignore";
        readonly onEmptyJsonBody?: "reject" | "ignore";
      } = {},
    ): HttpJsonBodyPolicy =>
      normalizeRequestBodyPolicy({ mode: "json", ...options }) as HttpJsonBodyPolicy,
    raw: (options: HttpRawBodyOptions): HttpRawBodyPolicy =>
      normalizeRequestBodyPolicy({
        mode: "raw",
        maxBytes: options?.maxBytes,
        contentTypes: options?.contentTypes ?? ["application/octet-stream"],
      }) as HttpRawBodyPolicy,
    multipart: (options: HttpMultipartBodyOptions): HttpMultipartBodyPolicy =>
      normalizeRequestBodyPolicy({
        mode: "multipart",
        maxBytes: options?.maxBytes,
        maxFileBytes: options?.maxFileBytes,
        maxFiles: options?.maxFiles ?? 1,
        maxFields: options?.maxFields ?? 16,
        maxFieldBytes:
          options?.maxFieldBytes ??
          (isPositiveSafeInteger(options?.maxBytes)
            ? Math.min(65_536, options.maxBytes)
            : undefined),
      }) as HttpMultipartBodyPolicy,
  }),
  get: <const TPath extends string, const TResponse extends HttpResponseDeclaration = "json">(
    path: TPath,
    options?: HttpTransportOptions<TResponse>,
  ) => defineHttpTransport("GET", path, options),
  post: <const TPath extends string, const TResponse extends HttpResponseDeclaration = "json">(
    path: TPath,
    options?: HttpTransportOptions<TResponse>,
  ) => defineHttpTransport("POST", path, options),
  put: <const TPath extends string, const TResponse extends HttpResponseDeclaration = "json">(
    path: TPath,
    options?: HttpTransportOptions<TResponse>,
  ) => defineHttpTransport("PUT", path, options),
  patch: <const TPath extends string, const TResponse extends HttpResponseDeclaration = "json">(
    path: TPath,
    options?: HttpTransportOptions<TResponse>,
  ) => defineHttpTransport("PATCH", path, options),
  delete: <const TPath extends string, const TResponse extends HttpResponseDeclaration = "json">(
    path: TPath,
    options?: HttpTransportOptions<TResponse>,
  ) => defineHttpTransport("DELETE", path, options),
  options: <const TPath extends string, const TResponse extends HttpResponseDeclaration = "json">(
    path: TPath,
    options?: HttpTransportOptions<TResponse>,
  ) => defineHttpTransport("OPTIONS", path, options),
  route: <
    const TMethod extends HttpMethod,
    const TPath extends string,
    const TResponse extends HttpResponseDeclaration = "json",
  >(
    method: TMethod,
    path: TPath,
    options?: HttpTransportOptions<TResponse>,
  ) => defineHttpTransport(method, path, options),
});

export function isHttpTransport(value: OperationTransport | undefined): value is HttpTransport {
  if (value?.kind !== "http") return false;
  const metadata = value.metadata;
  if (!metadata) return false;
  const method = Reflect.get(metadata, "method");
  const path = Reflect.get(metadata, "path");
  const response = Reflect.get(metadata, "response");
  const contentType = Reflect.get(metadata, "contentType");
  const contentTypes = Reflect.get(metadata, "contentTypes");
  const requestBody = Reflect.get(metadata, "requestBody");
  const queryParsing = Reflect.get(metadata, "queryParsing");
  const streamDeclaration = value.response;
  const streamConsistent =
    response === "stream"
      ? isHttpStreamResponse(streamDeclaration) && contentType === HTTP_STREAM_CONTENT_TYPE
      : streamDeclaration === undefined;
  // A bodiless representation exists only on kernel webhook transports.
  const representationConsistent =
    response === "empty"
      ? contentType === undefined && isWebhookMetadata(Reflect.get(metadata, "webhook"))
      : response === "redirect"
        ? contentType === undefined
        : isContentType(contentType);
  const alternativesConsistent =
    contentTypes === undefined ||
    (response === "binary" &&
      Array.isArray(contentTypes) &&
      contentTypes.length >= 2 &&
      contentTypes[0] === contentType &&
      contentTypes.every((choice: unknown) => isContentType(choice)) &&
      new Set(contentTypes.map((choice: string) => choice.toLowerCase())).size ===
        contentTypes.length);
  return (
    isHttpMethod(method) &&
    typeof path === "string" &&
    isValidHttpPath(path) &&
    isHttpResponseMode(response) &&
    representationConsistent &&
    alternativesConsistent &&
    isHttpRequestBodyPolicy(requestBody) &&
    (queryParsing === undefined || isHttpQueryParsing(queryParsing)) &&
    streamConsistent &&
    value.binding === `${method} ${path}`
  );
}

export function isHttpStreamTransport(
  value: OperationTransport | undefined,
): value is HttpTransport<HttpMethod, string, HttpStreamResponse> {
  return isHttpTransport(value) && value.metadata.response === "stream";
}

export function isHttpStreamResponse(value: unknown): value is HttpStreamResponse {
  return isOperationStreamResponse(value) && value.framing === "sse";
}

function normalizeRequestBodyPolicy(policy: unknown): HttpRequestBodyPolicy {
  const supplied = policy ?? { mode: "json" };
  const candidate =
    typeof supplied === "object" &&
    supplied !== null &&
    Reflect.get(supplied, "mode") === "raw" &&
    Array.isArray(Reflect.get(supplied, "contentTypes"))
      ? {
          ...supplied,
          contentTypes: Reflect.get(supplied, "contentTypes").map((value: unknown) =>
            typeof value === "string" ? value.toLowerCase() : value,
          ),
        }
      : supplied;
  if (!isHttpRequestBodyPolicy(candidate)) {
    throw new InvalidHttpTransportError(
      `invalid HTTP request body policy ${JSON.stringify(candidate)}`,
    );
  }
  if (candidate.mode === "json") {
    return Object.freeze({
      mode: candidate.mode,
      ...(candidate.maxBytes === undefined ? {} : { maxBytes: candidate.maxBytes }),
      ...(candidate.onNonJsonContentType === undefined
        ? {}
        : { onNonJsonContentType: candidate.onNonJsonContentType }),
      ...(candidate.onInvalidJson === undefined ? {} : { onInvalidJson: candidate.onInvalidJson }),
      ...(candidate.onEmptyJsonBody === undefined
        ? {}
        : { onEmptyJsonBody: candidate.onEmptyJsonBody }),
    });
  }
  if (candidate.mode === "raw") {
    return Object.freeze({
      mode: candidate.mode,
      maxBytes: candidate.maxBytes,
      contentTypes: Object.freeze([...candidate.contentTypes]),
    });
  }
  return Object.freeze({
    mode: candidate.mode,
    maxBytes: candidate.maxBytes,
    maxFiles: candidate.maxFiles,
    maxFileBytes: candidate.maxFileBytes,
    maxFields: candidate.maxFields,
    maxFieldBytes: candidate.maxFieldBytes,
  });
}

function isHttpRequestBodyPolicy(value: unknown): value is HttpRequestBodyPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const mode = Reflect.get(value, "mode");
  const maxBytes = Reflect.get(value, "maxBytes");
  if (mode === "json") {
    const onNonJsonContentType = Reflect.get(value, "onNonJsonContentType");
    const onInvalidJson = Reflect.get(value, "onInvalidJson");
    const onEmptyJsonBody = Reflect.get(value, "onEmptyJsonBody");
    return (
      hasOnlyKeys(value, [
        "mode",
        "maxBytes",
        "onNonJsonContentType",
        "onInvalidJson",
        "onEmptyJsonBody",
      ]) &&
      (maxBytes === undefined || isPositiveSafeInteger(maxBytes)) &&
      (onNonJsonContentType === undefined ||
        onNonJsonContentType === "reject" ||
        onNonJsonContentType === "ignore") &&
      (onInvalidJson === undefined || onInvalidJson === "reject" || onInvalidJson === "ignore") &&
      (onEmptyJsonBody === undefined ||
        onEmptyJsonBody === "reject" ||
        onEmptyJsonBody === "ignore")
    );
  }
  if (mode === "raw") {
    const contentTypes = Reflect.get(value, "contentTypes");
    return (
      hasOnlyKeys(value, ["mode", "maxBytes", "contentTypes"]) &&
      isPositiveSafeInteger(maxBytes) &&
      Array.isArray(contentTypes) &&
      contentTypes.length > 0 &&
      contentTypes.every(
        (contentType, index) =>
          isBareContentType(contentType) && contentTypes.indexOf(contentType) === index,
      )
    );
  }
  if (mode !== "multipart") return false;
  const maxFiles = Reflect.get(value, "maxFiles");
  const maxFileBytes = Reflect.get(value, "maxFileBytes");
  const maxFields = Reflect.get(value, "maxFields");
  const maxFieldBytes = Reflect.get(value, "maxFieldBytes");
  return (
    hasOnlyKeys(value, [
      "mode",
      "maxBytes",
      "maxFiles",
      "maxFileBytes",
      "maxFields",
      "maxFieldBytes",
    ]) &&
    isPositiveSafeInteger(maxBytes) &&
    isNonNegativeSafeInteger(maxFiles) &&
    isPositiveSafeInteger(maxFileBytes) &&
    maxFileBytes <= maxBytes &&
    isNonNegativeSafeInteger(maxFields) &&
    Number(maxFiles) + Number(maxFields) > 0 &&
    isPositiveSafeInteger(maxFieldBytes) &&
    maxFieldBytes <= maxBytes
  );
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isHttpUnaryResponseMode(value: unknown): value is HttpUnaryResponseMode {
  return value === "json" || value === "text" || value === "binary" || value === "redirect";
}

function isHttpResponseMode(value: unknown): value is HttpResponseMode {
  return isHttpUnaryResponseMode(value) || value === "stream" || value === "empty";
}

function isHttpQueryParsing(value: unknown): value is HttpQueryParsing {
  return value === "strict" || value === "first-value" || value === "literal-keys";
}

function isWebhookMetadata(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "provider") === "string"
  );
}

function defaultContentType(response: HttpUnaryResponseMode): string {
  if (response === "json") return "application/json; charset=UTF-8";
  if (response === "text") return "text/plain; charset=UTF-8";
  if (response === "redirect") throw new TypeError("redirect responses have no content type");
  return "application/octet-stream";
}

function isContentType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n]+)*$/u.test(value)
  );
}

function isBareContentType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value)
  );
}

function isHttpMethod(value: unknown): value is HttpMethod {
  return (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE" ||
    value === "OPTIONS"
  );
}

function assertHttpPath(path: unknown): asserts path is string {
  if (!isValidHttpPath(path)) {
    throw new InvalidHttpTransportError(
      `HTTP path ${JSON.stringify(path)} must start with /, contain no query, fragment, whitespace, empty segment, or trailing slash, and use only :name path parameters`,
    );
  }
}

function isValidHttpPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path === "/") return true;
  if (!path.startsWith("/") || path.endsWith("/") || path.includes("//") || /[\s?#]/u.test(path)) {
    return false;
  }

  const parameterNames = new Set<string>();
  for (const segment of path.slice(1).split("/")) {
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || parameterNames.has(name)) return false;
      parameterNames.add(name);
    } else if (!/^[A-Za-z0-9._~!$&'()+,;=@%-]+$/u.test(segment)) {
      return false;
    }
  }
  return true;
}
