import type { InferSchemaInput, InferSchemaOutput, RuntimeSchema } from "./schema.js";
import { isRuntimeSchema } from "./schema.js";

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FRAMEWORK_ERROR_CODES = new Set([
  "VALIDATION_ERROR",
  "AUTHENTICATION_ERROR",
  "AUTHORIZATION_ERROR",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "INTERNAL_SERVER_ERROR",
  "AUTHENTICATION_UNAVAILABLE",
  "IDEMPOTENT_IN_FLIGHT",
]);
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
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

export interface OperationErrorDefinition<
  TCode extends string = string,
  TStatus extends number = number,
  TDetails extends RuntimeSchema | undefined = RuntimeSchema | undefined,
  THeaders extends readonly string[] | undefined = readonly string[] | undefined,
> {
  readonly kind: "ship.operation-error";
  readonly code: TCode;
  readonly status: TStatus;
  readonly message: string;
  readonly details?: TDetails;
  /** HTTP response headers allowed on this declared failure. */
  readonly headers?: THeaders;
}

type DetailsSchema<TError extends OperationErrorDefinition> = Exclude<TError["details"], undefined>;

export type OperationErrorDetailsInput<TError extends OperationErrorDefinition> = [
  DetailsSchema<TError>,
] extends [never]
  ? never
  : DetailsSchema<TError> extends RuntimeSchema
    ? InferSchemaInput<DetailsSchema<TError>>
    : never;

export type OperationErrorDetails<TError extends OperationErrorDefinition> = [
  DetailsSchema<TError>,
] extends [never]
  ? never
  : DetailsSchema<TError> extends RuntimeSchema
    ? InferSchemaOutput<DetailsSchema<TError>>
    : never;

interface OperationFailureBaseOptions {
  readonly message?: string;
  readonly cause?: unknown;
}

type DeclaredHeaderNames<TError extends OperationErrorDefinition> =
  TError extends OperationErrorDefinition<string, number, RuntimeSchema | undefined, infer THeaders>
    ? undefined extends THeaders
      ? never
      : THeaders extends readonly string[]
        ? THeaders[number]
        : never
    : never;

type OperationFailureHeaderOptions<TError extends OperationErrorDefinition> = [
  DeclaredHeaderNames<TError>,
] extends [never]
  ? { readonly headers?: never }
  : { readonly headers: Readonly<Record<DeclaredHeaderNames<TError>, string>> };

export type OperationFailureOptions<TError extends OperationErrorDefinition> = [
  DetailsSchema<TError>,
] extends [never]
  ? OperationFailureBaseOptions & {
      readonly details?: never;
    } & OperationFailureHeaderOptions<TError>
  : OperationFailureBaseOptions & {
      readonly details: OperationErrorDetailsInput<TError>;
    } & OperationFailureHeaderOptions<TError>;

export class OperationFailure<
  TError extends OperationErrorDefinition = OperationErrorDefinition,
> extends Error {
  readonly code: TError["code"];
  readonly definition: TError;
  readonly details?: OperationErrorDetailsInput<TError>;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(
    definition: TError,
    options: OperationFailureBaseOptions & {
      readonly details?: OperationErrorDetailsInput<TError>;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(options.message ?? definition.message, { cause: options.cause });
    this.name = "OperationFailure";
    this.code = definition.code;
    this.definition = definition;
    this.details = options.details;
    this.headers = validateOperationFailureHeaders(definition, options.headers);
  }
}

export function operationError<
  const TCode extends string,
  const TStatus extends number,
  const TDetails extends RuntimeSchema | undefined = undefined,
  const THeaders extends readonly string[] | undefined = undefined,
>(definition: {
  readonly code: TCode;
  readonly status: TStatus;
  readonly message: string;
  readonly details?: TDetails;
  readonly headers?: THeaders;
}): OperationErrorDefinition<TCode, TStatus, TDetails, THeaders> {
  if (!ERROR_CODE_PATTERN.test(definition.code)) {
    throw new TypeError(
      `operation error code must be uppercase snake case; received ${JSON.stringify(definition.code)}`,
    );
  }
  if (FRAMEWORK_ERROR_CODES.has(definition.code)) {
    throw new TypeError(
      `operation error code ${JSON.stringify(definition.code)} is reserved by the framework`,
    );
  }
  if (!Number.isInteger(definition.status) || definition.status < 400 || definition.status > 599) {
    throw new TypeError("operation error status must be an integer from 400 through 599");
  }
  if (definition.message.trim().length === 0) {
    throw new TypeError("operation error message must not be empty");
  }
  if (definition.details !== undefined && !isRuntimeSchema(definition.details)) {
    throw new TypeError("operation error details must implement Standard Schema v1");
  }
  if (definition.headers !== undefined && !isFailureHeaderNames(definition.headers)) {
    throw new TypeError("operation error headers must be distinct safe HTTP header names");
  }

  return Object.freeze({
    ...definition,
    ...(definition.headers ? { headers: Object.freeze([...definition.headers]) } : {}),
    kind: "ship.operation-error" as const,
  }) as unknown as OperationErrorDefinition<TCode, TStatus, TDetails, THeaders>;
}

export function operationFailure<TError extends OperationErrorDefinition>(
  definition: TError,
  ...[options]: [DetailsSchema<TError>] extends [never]
    ? [DeclaredHeaderNames<TError>] extends [never]
      ? [options?: OperationFailureOptions<TError>]
      : [options: OperationFailureOptions<TError>]
    : [options: OperationFailureOptions<TError>]
): OperationFailure<TError> {
  return new OperationFailure(definition, options ?? {});
}

export function isOperationErrorDefinition(value: unknown): value is OperationErrorDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.operation-error" &&
    typeof Reflect.get(value, "code") === "string" &&
    ERROR_CODE_PATTERN.test(Reflect.get(value, "code")) &&
    !FRAMEWORK_ERROR_CODES.has(Reflect.get(value, "code")) &&
    typeof Reflect.get(value, "status") === "number" &&
    Number.isInteger(Reflect.get(value, "status")) &&
    Reflect.get(value, "status") >= 400 &&
    Reflect.get(value, "status") <= 599 &&
    typeof Reflect.get(value, "message") === "string" &&
    Reflect.get(value, "message").trim().length > 0 &&
    (Reflect.get(value, "details") === undefined ||
      isRuntimeSchema(Reflect.get(value, "details"))) &&
    (Reflect.get(value, "headers") === undefined ||
      isFailureHeaderNames(Reflect.get(value, "headers")))
  );
}

function isFailureHeaderNames(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const names = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || !HTTP_HEADER_NAME.test(name)) return false;
    const lower = name.toLowerCase();
    if (RESERVED_FAILURE_HEADERS.has(lower) || lower.startsWith("access-control-")) return false;
    if (names.has(lower)) return false;
    names.add(lower);
  }
  return true;
}

export function validateOperationFailureHeaders(
  definition: OperationErrorDefinition,
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (definition.headers === undefined && headers === undefined) return undefined;
  const declared = definition.headers;
  if (!declared || !headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("operation failure headers must match the error declaration");
  }
  const entries = Object.entries(headers);
  const expected = new Set(declared.map((name) => name.toLowerCase()));
  if (entries.length !== expected.size) {
    throw new TypeError("operation failure headers must match the error declaration");
  }
  const normalized: [string, string][] = [];
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!expected.delete(lower) || !isSafeFailureHeaderValue(value)) {
      throw new TypeError("operation failure headers must match the error declaration");
    }
    normalized.push([lower, value]);
  }
  return Object.freeze(Object.fromEntries(normalized));
}

/** Shared wire validation; adapters must recheck direct or forged executor results. */
export function isSafeFailureHeaderValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[\x20-\x7E]+$/u.test(value) &&
    value.trim() === value
  );
}
