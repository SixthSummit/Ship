import type { RuntimeSchema, SchemaIssue, SchemaResult } from "./schema.js";
import { CONTRACT_SCHEMA_METADATA_KEY } from "./schema.js";

/**
 * Minimal Standard Schema builders for framework-owned operations.
 *
 * The kernel has no schema vendor dependency, but framework operations such as
 * the outbox dispatcher still need typed, projectable input and output. Each
 * schema also carries the `~ship.contract` JSON Schema metadata that
 * `@sixthsummit/ship-contract` reads, so framework operations project into
 * client contracts and OpenAPI exactly like consumer operations.
 */

const CONTRACT_METADATA_KEY = CONTRACT_SCHEMA_METADATA_KEY;

export interface FrameworkSchema<TValue> extends RuntimeSchema<TValue, TValue> {
  readonly "~standard": RuntimeSchema<TValue, TValue>["~standard"] & {
    /** Type-only inference hook; never populated at runtime. */
    readonly types?: { readonly input: TValue; readonly output: TValue } | undefined;
  };
  readonly "~ship.contract": { readonly jsonSchema: Readonly<Record<string, unknown>> };
}

export type FrameworkFieldSchema<TValue> = FrameworkSchema<TValue> & {
  readonly optional?: boolean;
};

type Validator<TValue> = (value: unknown, path: readonly PropertyKey[]) => SchemaResult<TValue>;

function frameworkSchema<TValue>(
  validate: Validator<TValue>,
  jsonSchema: Readonly<Record<string, unknown>>,
  optional = false,
): FrameworkFieldSchema<TValue> {
  return Object.freeze({
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "ship",
      validate: (value: unknown) => validate(value, []),
    }),
    [CONTRACT_METADATA_KEY]: Object.freeze({ jsonSchema: deepFreeze(jsonSchema) }),
    ...(optional ? { optional: true } : {}),
  }) as FrameworkFieldSchema<TValue>;
}

function issue(message: string, path: readonly PropertyKey[]): SchemaResult<never> {
  const failure: SchemaIssue = { message, path: [...path] };
  return { issues: [failure] };
}

export function stringSchema(options: { readonly minLength?: number } = {}) {
  const minLength = options.minLength ?? 0;
  return frameworkSchema<string>(
    (value, path) =>
      typeof value === "string" && value.length >= minLength
        ? { value }
        : issue(`expected a string with at least ${minLength} characters`, path),
    { type: "string", minLength },
  );
}

export function integerSchema(options: { readonly minimum?: number; readonly maximum?: number }) {
  return frameworkSchema<number>(
    (value, path) =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      (options.minimum === undefined || value >= options.minimum) &&
      (options.maximum === undefined || value <= options.maximum)
        ? { value }
        : issue("expected an integer within the declared range", path),
    {
      type: "integer",
      ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
      ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
    },
  );
}

/** Accepts any JSON value; used for opaque intent payloads. */
export function jsonValueSchema() {
  return frameworkSchema<unknown>((value) => ({ value }), {});
}

export function booleanSchema() {
  return frameworkSchema<boolean>(
    (value, path) => (typeof value === "boolean" ? { value } : issue("expected a boolean", path)),
    { type: "boolean" },
  );
}

/** Byte-exact request bodies; projects as a binary string for contracts. */
export function bytesSchema() {
  return frameworkSchema<Uint8Array>(
    (value, path) =>
      value instanceof Uint8Array ? { value } : issue("expected a byte array", path),
    { type: "string", format: "binary" },
  );
}

/**
 * Accepts only `undefined`: the output of a response that carries no entity
 * body (for example an `empty`-mode webhook acknowledgement).
 */
export function emptySchema() {
  return frameworkSchema<undefined>(
    (value, path) =>
      value === undefined
        ? { value: undefined }
        : issue("expected no response body; the declared response mode is empty", path),
    { not: {} },
  );
}

/** A string-keyed map whose values all satisfy one schema (for example lower-case headers). */
export function recordSchema<TValue>(
  item: FrameworkFieldSchema<TValue>,
): FrameworkFieldSchema<Readonly<Record<string, TValue>>> {
  return frameworkSchema<Readonly<Record<string, TValue>>>(
    (value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return issue("expected an object", path);
      }
      const parsed: Record<string, TValue> = {};
      for (const [key, entry] of Object.entries(value)) {
        const result = item["~standard"].validate(entry) as SchemaResult<TValue>;
        if ("issues" in result && result.issues) {
          return {
            issues: result.issues.map((entryIssue) => ({
              ...entryIssue,
              path: [...path, key, ...(entryIssue.path ?? [])],
            })),
          };
        }
        parsed[key] = result.value;
      }
      return { value: Object.freeze(parsed) };
    },
    { type: "object", additionalProperties: item[CONTRACT_METADATA_KEY].jsonSchema },
  );
}

export function optionalSchema<TValue>(
  schema: FrameworkFieldSchema<TValue>,
): FrameworkSchema<TValue | undefined> & { readonly optional: true } {
  return frameworkSchema<TValue | undefined>(
    (value) =>
      value === undefined
        ? { value: undefined }
        : (schema["~standard"].validate(value) as SchemaResult<TValue>),
    schema[CONTRACT_METADATA_KEY].jsonSchema,
    true,
  ) as FrameworkSchema<TValue | undefined> & { readonly optional: true };
}

export function arraySchema<TValue>(
  item: FrameworkFieldSchema<TValue>,
): FrameworkFieldSchema<readonly TValue[]> {
  return frameworkSchema<readonly TValue[]>(
    (value, path) => {
      if (!Array.isArray(value)) return issue("expected an array", path);
      const items: TValue[] = [];
      for (const [index, entry] of value.entries()) {
        const result = item["~standard"].validate(entry) as SchemaResult<TValue>;
        if ("issues" in result && result.issues) {
          return {
            issues: result.issues.map((entryIssue) => ({
              ...entryIssue,
              path: [...path, index, ...(entryIssue.path ?? [])],
            })),
          };
        }
        items.push(result.value);
      }
      return { value: Object.freeze(items) };
    },
    { type: "array", items: item[CONTRACT_METADATA_KEY].jsonSchema },
  );
}

type ObjectFields = Readonly<Record<string, FrameworkFieldSchema<unknown>>>;
type InferObject<TFields extends ObjectFields> = {
  readonly [TKey in keyof TFields as TFields[TKey] extends { readonly optional: true }
    ? never
    : TKey]: TFields[TKey] extends FrameworkFieldSchema<infer TValue> ? TValue : never;
} & {
  readonly [TKey in keyof TFields as TFields[TKey] extends { readonly optional: true }
    ? TKey
    : never]?: TFields[TKey] extends FrameworkFieldSchema<infer TValue> ? TValue : never;
};

export function objectSchema<const TFields extends ObjectFields>(
  fields: TFields,
): FrameworkFieldSchema<InferObject<TFields>> {
  const required = Object.keys(fields)
    .filter((key) => fields[key]?.optional !== true)
    .sort();
  return frameworkSchema<InferObject<TFields>>(
    (value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return issue("expected an object", path);
      }
      const parsed: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(fields)) {
        const raw = Reflect.get(value, key);
        if (raw === undefined && field.optional) continue;
        const result = field["~standard"].validate(raw) as SchemaResult<unknown>;
        if ("issues" in result && result.issues) {
          return {
            issues: result.issues.map((item) => ({
              ...item,
              path: [...path, key, ...(item.path ?? [])],
            })),
          };
        }
        parsed[key] = result.value;
      }
      return { value: Object.freeze(parsed) as InferObject<TFields> };
    },
    {
      type: "object",
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
      properties: Object.fromEntries(
        Object.entries(fields)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, field]) => [key, field[CONTRACT_METADATA_KEY].jsonSchema]),
      ),
    },
  );
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
