/**
 * The small subset of Standard Schema v1 required by the Ship kernel.
 *
 * Keeping this structural means operation declarations work with Zod and any
 * other Standard Schema implementation without making the kernel's types
 * depend on one schema vendor.
 */
export interface RuntimeSchema<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: { readonly libraryOptions?: Record<string, unknown> | undefined },
    ) => SchemaResult<TOutput> | Promise<SchemaResult<TOutput>>;
    readonly types?:
      | {
          readonly input: TInput;
          readonly output: TOutput;
        }
      | undefined;
  };
}

export type SchemaResult<TOutput> =
  | { readonly value: TOutput; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

export interface SchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export type InferSchemaInput<TSchema extends RuntimeSchema> = NonNullable<
  TSchema["~standard"]["types"]
>["input"];

export type InferSchemaOutput<TSchema extends RuntimeSchema> = NonNullable<
  TSchema["~standard"]["types"]
>["output"];

export function isRuntimeSchema(value: unknown): value is RuntimeSchema {
  if (typeof value !== "object" || value === null) return false;

  const standard = Reflect.get(value, "~standard");
  if (typeof standard !== "object" || standard === null) return false;

  return (
    Reflect.get(standard, "version") === 1 &&
    typeof Reflect.get(standard, "vendor") === "string" &&
    typeof Reflect.get(standard, "validate") === "function"
  );
}

/**
 * Property under which a Standard Schema carries the client-safe JSON Schema
 * `@sixthsummit/ship-contract` projects into manifests and OpenAPI. The
 * framework schema builders attach it; `contractSchema()` attaches it to any
 * vendor's schema.
 */
export const CONTRACT_SCHEMA_METADATA_KEY = "~ship.contract";

export interface ContractSchemaProjection {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  /** Named browser-safe codec the generated client applies. */
  readonly codec?: string;
}

/**
 * A Standard Schema that carries its own manifest projection, so the contract
 * can project it without knowing the vendor. Operation inputs, outputs and
 * channel payloads either satisfy this or come from a vendor in
 * {@link NATIVELY_PROJECTED_SCHEMA_VENDORS}.
 */
export interface ProjectableRuntimeSchema<TInput = unknown, TOutput = TInput>
  extends RuntimeSchema<TInput, TOutput> {
  readonly [CONTRACT_SCHEMA_METADATA_KEY]: ContractSchemaProjection;
}

/**
 * Vendors whose validators `@sixthsummit/ship-contract` projects from the
 * schema itself, with no declared metadata (Zod v4 through `toJSONSchema`).
 * The kernel only names them so compilation can warn before a manifest build
 * fails; the projection lives in the contract package.
 */
export const NATIVELY_PROJECTED_SCHEMA_VENDORS: readonly string[] = Object.freeze(["zod"]);

export function hasContractProjection(value: unknown): value is ProjectableRuntimeSchema {
  if (!isRuntimeSchema(value)) return false;
  const metadata = Reflect.get(value, CONTRACT_SCHEMA_METADATA_KEY);
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    typeof Reflect.get(metadata, "jsonSchema") === "object" &&
    Reflect.get(metadata, "jsonSchema") !== null
  );
}

/** True when the manifest can derive a JSON Schema: declared metadata, or a natively projected vendor. */
export function isManifestProjectable(schema: RuntimeSchema): boolean {
  return (
    hasContractProjection(schema) ||
    NATIVELY_PROJECTED_SCHEMA_VENDORS.includes(schema["~standard"].vendor)
  );
}
