import type { InferSchemaInput, InferSchemaOutput, RuntimeSchema } from "@sixthsummit/ship-core";
import { isRuntimeSchema } from "@sixthsummit/ship-core";
import { z } from "zod";
import type { JsonObject, JsonSchema, JsonValue, ProjectedContractSchema } from "./manifest.js";

const CONTRACT_METADATA_KEY = "~ship.contract";
const CODEC_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

export type {
  JsonObject,
  JsonPrimitive,
  JsonSchema,
  JsonValue,
  ProjectedContractSchema,
} from "./manifest.js";

export type ContractProjectionDiagnosticCode =
  | "SHIP_CONTRACT_SCHEMA_UNSUPPORTED"
  | "SHIP_CONTRACT_SCHEMA_INVALID"
  | "SHIP_CONTRACT_CODEC_INVALID"
  | "SHIP_CONTRACT_HTTP_REQUIRED"
  | "SHIP_CONTRACT_INPUT_LOCATION_UNSUPPORTED"
  | "SHIP_CONTRACT_GET_BODY_UNSUPPORTED"
  | "SHIP_CONTRACT_PATH_PARAMETER_MISMATCH"
  | "SHIP_CONTRACT_PARAMETER_SCHEMA_INVALID";

export class ContractProjectionError extends Error {
  readonly code: ContractProjectionDiagnosticCode;
  readonly operationId?: string;
  readonly channelId?: string;
  readonly path?: string;

  constructor(
    code: ContractProjectionDiagnosticCode,
    message: string,
    options: {
      readonly operationId?: string;
      readonly channelId?: string;
      readonly path?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ContractProjectionError";
    this.code = code;
    this.operationId = options.operationId;
    this.channelId = options.channelId;
    this.path = options.path;
  }
}

/** Identifies the declaration a schema projection belongs to. */
export type ContractSchemaContext = (
  | { readonly operationId: string; readonly channelId?: undefined }
  | { readonly channelId: string; readonly operationId?: undefined }
) & {
  readonly path: string;
  /** Selects the wire-facing side of schemas that normalize input values. */
  readonly io?: "input" | "output";
};

export interface ContractSchemaMetadata {
  readonly jsonSchema: JsonSchema;
  /** Named browser-safe codec supplied to createHttpOperationClient(). */
  readonly codec?: string;
}

export interface ContractSchema<TInput = unknown, TOutput = TInput>
  extends RuntimeSchema<TInput, TOutput> {
  readonly "~ship.contract": ContractSchemaMetadata;
}

export interface ContractSchemaOptions {
  readonly jsonSchema: JsonSchema;
  readonly codec?: string;
}

/**
 * Adds a client-safe JSON Schema projection to a Standard Schema.
 *
 * Use this for non-Zod vendors or values that need an explicit wire codec.
 * The runtime validator remains authoritative; this metadata is consumed only
 * by contract/OpenAPI projection and the generated HTTP client.
 */
export function contractSchema<TSchema extends RuntimeSchema>(
  schema: TSchema,
  options: ContractSchemaOptions,
): ContractSchema<InferSchemaInput<TSchema>, InferSchemaOutput<TSchema>> {
  if (!isRuntimeSchema(schema) || typeof options !== "object" || options === null) {
    throw new ContractProjectionError(
      "SHIP_CONTRACT_SCHEMA_INVALID",
      "contractSchema requires a Standard Schema v1 validator and JSON Schema options",
    );
  }
  if (options.codec !== undefined && !CODEC_ID_PATTERN.test(options.codec)) {
    throw new ContractProjectionError(
      "SHIP_CONTRACT_CODEC_INVALID",
      `contract codec id must be lowercase dot/dash notation; received ${JSON.stringify(options.codec)}`,
    );
  }
  let jsonSchema: JsonSchema;
  try {
    jsonSchema = cloneJsonSchema(options.jsonSchema);
  } catch (cause) {
    throw new ContractProjectionError(
      "SHIP_CONTRACT_SCHEMA_INVALID",
      `contract JSON Schema must contain only finite JSON-safe values: ${safeErrorMessage(cause)}`,
      { cause },
    );
  }
  return Object.freeze({
    "~standard": schema["~standard"],
    [CONTRACT_METADATA_KEY]: Object.freeze({
      jsonSchema,
      ...(options.codec ? { codec: options.codec } : {}),
    }),
  }) as ContractSchema<InferSchemaInput<TSchema>, InferSchemaOutput<TSchema>>;
}

export function projectContractSchema(
  schema: RuntimeSchema,
  context: ContractSchemaContext,
): ProjectedContractSchema {
  const metadata = Reflect.get(schema, CONTRACT_METADATA_KEY);
  if (metadata !== undefined) {
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("jsonSchema" in metadata) ||
      (Reflect.get(metadata, "codec") !== undefined &&
        (typeof Reflect.get(metadata, "codec") !== "string" ||
          !CODEC_ID_PATTERN.test(Reflect.get(metadata, "codec"))))
    ) {
      throw projectionError(
        "SHIP_CONTRACT_SCHEMA_INVALID",
        "contract schema metadata is invalid",
        context,
      );
    }
    try {
      return Object.freeze({
        vendor: schema["~standard"].vendor,
        jsonSchema: cloneJsonSchema(Reflect.get(metadata, "jsonSchema")),
        ...(Reflect.get(metadata, "codec")
          ? { codec: Reflect.get(metadata, "codec") as string }
          : {}),
      });
    } catch (cause) {
      if (cause instanceof ContractProjectionError) throw cause;
      throw projectionError(
        "SHIP_CONTRACT_SCHEMA_INVALID",
        "contract JSON Schema must contain only finite JSON-safe values",
        context,
        cause,
      );
    }
  }

  if (schema["~standard"].vendor !== "zod") {
    throw projectionError(
      "SHIP_CONTRACT_SCHEMA_UNSUPPORTED",
      `schema vendor ${JSON.stringify(schema["~standard"].vendor)} has no contract projection`,
      context,
    );
  }

  try {
    const projected = z.toJSONSchema(schema as z.ZodType, { io: context.io ?? "output" });
    const { $schema: _dialect, ...jsonSchema } = projected;
    return Object.freeze({
      vendor: "zod",
      jsonSchema: cloneJsonSchema(jsonSchema as JsonSchema),
    });
  } catch (cause) {
    throw projectionError(
      "SHIP_CONTRACT_SCHEMA_UNSUPPORTED",
      `Zod schema cannot be represented safely in the client contract: ${safeErrorMessage(cause)}`,
      context,
      cause,
    );
  }
}

export function stableJson<TValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => stableJson(item))) as TValue;
  }
  if (isJsonObject(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stableJson(item)]),
      ),
    ) as TValue;
  }
  return value;
}

function cloneJsonSchema(value: unknown): JsonSchema {
  const cloned = cloneJson(value, new WeakSet());
  if (!isJsonObject(cloned)) throw new TypeError("JSON Schema root must be an object");
  return stableJson(cloned);
}

function cloneJson(value: unknown, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("value is not JSON-safe");
  if (ancestors.has(value)) throw new TypeError("JSON value contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneJson(item, ancestors)));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects");
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, cloneJson(item, ancestors)]),
      ),
    );
  } finally {
    ancestors.delete(value);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectionError(
  code: ContractProjectionDiagnosticCode,
  message: string,
  context: ContractSchemaContext,
  cause?: unknown,
): ContractProjectionError {
  return new ContractProjectionError(code, message, {
    ...(context.operationId ? { operationId: context.operationId } : {}),
    ...(context.channelId ? { channelId: context.channelId } : {}),
    path: context.path,
    cause,
  });
}

function safeErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
