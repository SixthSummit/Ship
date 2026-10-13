import type { DependencyToken } from "./dependency.js";
import { isDependencyToken } from "./dependency.js";
import type { AnyOperation } from "./operation.js";
import type { AnyProvider } from "./provider.js";
import { isProvider } from "./provider.js";
import type { AnyChannel } from "./realtime.js";
import { isChannel } from "./realtime.js";

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export interface ModuleDefinition<
  TId extends string,
  TOperations extends readonly AnyOperation[],
  TProviders extends readonly AnyProvider[],
  TImports extends readonly string[],
  TExports extends readonly DependencyToken[],
  TChannels extends readonly AnyChannel[] = readonly AnyChannel[],
> {
  readonly id: TId;
  readonly operations: TOperations;
  readonly providers: TProviders;
  readonly imports: TImports;
  readonly exports: TExports;
  /** Realtime channels owned by this module. Operations publish only to declared channels. */
  readonly channels?: TChannels;
}

export interface ShipModule<
  TId extends string,
  TOperations extends readonly AnyOperation[],
  TProviders extends readonly AnyProvider[],
  TImports extends readonly string[],
  TExports extends readonly DependencyToken[],
  TChannels extends readonly AnyChannel[] = readonly AnyChannel[],
> extends ModuleDefinition<TId, TOperations, TProviders, TImports, TExports, TChannels> {
  readonly kind: "ship.module";
  /** Typed per module so the client contract can enumerate channel ids and payloads. */
  readonly channels: TChannels;
}

export interface AnyModule {
  readonly kind: "ship.module";
  readonly id: string;
  readonly operations: readonly AnyOperation[];
  readonly providers: readonly AnyProvider[];
  readonly imports: readonly string[];
  readonly exports: readonly DependencyToken[];
  readonly channels: readonly AnyChannel[];
}

export type ModuleDiagnosticCode =
  | "SHIP_MODULE_DEFINITION_INVALID"
  | "SHIP_MODULE_ID_INVALID"
  | "SHIP_MODULE_OPERATION_INVALID"
  | "SHIP_MODULE_PROVIDER_INVALID"
  | "SHIP_MODULE_IMPORT_INVALID"
  | "SHIP_MODULE_IMPORT_DUPLICATE"
  | "SHIP_MODULE_SELF_IMPORT"
  | "SHIP_MODULE_EXPORT_INVALID"
  | "SHIP_MODULE_EXPORT_DUPLICATE"
  | "SHIP_MODULE_CHANNEL_INVALID"
  | "SHIP_MODULE_CHANNEL_DUPLICATE";

export class InvalidModuleDefinitionError extends Error {
  readonly code: ModuleDiagnosticCode;
  readonly moduleId?: string;
  readonly field?: string;

  constructor(
    code: ModuleDiagnosticCode,
    message: string,
    options: { readonly moduleId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidModuleDefinitionError";
    this.code = code;
    this.moduleId = options.moduleId;
    this.field = options.field;
  }
}

// Two overloads so a module declared without `channels` types them as the
// empty tuple even inside `defineApp({ modules })`, where the contextual
// `readonly AnyModule[]` would otherwise widen them to `readonly AnyChannel[]`
// and erase every channel id from the application contract.
export function defineModule<
  const TId extends string,
  const TOperations extends readonly AnyOperation[],
  const TProviders extends readonly AnyProvider[],
  const TImports extends readonly string[],
  const TExports extends readonly DependencyToken[],
>(
  definition: ModuleDefinition<TId, TOperations, TProviders, TImports, TExports, readonly []> & {
    readonly channels?: undefined;
  },
): ShipModule<TId, TOperations, TProviders, TImports, TExports, readonly []>;
export function defineModule<
  const TId extends string,
  const TOperations extends readonly AnyOperation[],
  const TProviders extends readonly AnyProvider[],
  const TImports extends readonly string[],
  const TExports extends readonly DependencyToken[],
  const TChannels extends readonly AnyChannel[],
>(
  definition: ModuleDefinition<TId, TOperations, TProviders, TImports, TExports, TChannels> & {
    readonly channels: TChannels;
  },
): ShipModule<TId, TOperations, TProviders, TImports, TExports, TChannels>;
export function defineModule<
  const TId extends string,
  const TOperations extends readonly AnyOperation[],
  const TProviders extends readonly AnyProvider[],
  const TImports extends readonly string[],
  const TExports extends readonly DependencyToken[],
  const TChannels extends readonly AnyChannel[] = readonly [],
>(
  definition: ModuleDefinition<TId, TOperations, TProviders, TImports, TExports, TChannels>,
): ShipModule<TId, TOperations, TProviders, TImports, TExports, TChannels> {
  assertModuleDefinition(definition);

  return Object.freeze({
    ...definition,
    kind: "ship.module" as const,
    operations: Object.freeze([...definition.operations]) as unknown as TOperations,
    providers: Object.freeze([...definition.providers]) as unknown as TProviders,
    imports: Object.freeze([...definition.imports]) as unknown as TImports,
    exports: Object.freeze([...definition.exports]) as unknown as TExports,
    channels: Object.freeze([...(definition.channels ?? [])]) as unknown as TChannels,
  });
}

export function isShipModule(value: unknown): value is AnyModule {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.module" &&
    typeof Reflect.get(value, "id") === "string" &&
    Array.isArray(Reflect.get(value, "operations")) &&
    Array.isArray(Reflect.get(value, "providers")) &&
    Array.isArray(Reflect.get(value, "imports")) &&
    Array.isArray(Reflect.get(value, "exports")) &&
    Array.isArray(Reflect.get(value, "channels"))
  );
}

function assertModuleDefinition(
  definition: unknown,
): asserts definition is ModuleDefinition<
  string,
  readonly AnyOperation[],
  readonly AnyProvider[],
  readonly string[],
  readonly DependencyToken[]
> {
  if (typeof definition !== "object" || definition === null) {
    fail("SHIP_MODULE_DEFINITION_INVALID", "module definition must be an object");
  }

  const id = Reflect.get(definition, "id");
  const moduleId = typeof id === "string" ? id : undefined;
  if (!moduleId || !MODULE_ID_PATTERN.test(moduleId)) {
    fail(
      "SHIP_MODULE_ID_INVALID",
      "module id must be a lowercase dot-separated identifier",
      moduleId,
      "id",
    );
  }

  assertArray(
    Reflect.get(definition, "operations"),
    (value): value is AnyOperation =>
      typeof value === "object" &&
      value !== null &&
      Reflect.get(value, "kind") === "ship.operation",
    "SHIP_MODULE_OPERATION_INVALID",
    "operations must contain only defineOperation() results",
    moduleId,
    "operations",
  );
  assertArray(
    Reflect.get(definition, "providers"),
    isProvider,
    "SHIP_MODULE_PROVIDER_INVALID",
    "providers must contain only defineProvider() results",
    moduleId,
    "providers",
  );

  const imports = Reflect.get(definition, "imports");
  assertArray(
    imports,
    (value): value is string => typeof value === "string" && MODULE_ID_PATTERN.test(value),
    "SHIP_MODULE_IMPORT_INVALID",
    "imports must contain valid module ids",
    moduleId,
    "imports",
  );
  assertUnique(imports, "SHIP_MODULE_IMPORT_DUPLICATE", "module import", moduleId, "imports");
  if (imports.includes(moduleId)) {
    fail("SHIP_MODULE_SELF_IMPORT", "a module cannot import itself", moduleId, "imports");
  }

  const exports = Reflect.get(definition, "exports");
  assertArray(
    exports,
    isDependencyToken,
    "SHIP_MODULE_EXPORT_INVALID",
    "exports must contain dependency tokens",
    moduleId,
    "exports",
  );
  assertUnique(
    exports.map((token) => token.id),
    "SHIP_MODULE_EXPORT_DUPLICATE",
    "module export",
    moduleId,
    "exports",
  );

  const channels = Reflect.get(definition, "channels") ?? [];
  assertArray(
    channels,
    isChannel,
    "SHIP_MODULE_CHANNEL_INVALID",
    "channels must contain only defineChannel() results",
    moduleId,
    "channels",
  );
  assertUnique(
    channels.map((channel) => channel.id),
    "SHIP_MODULE_CHANNEL_DUPLICATE",
    "module channel",
    moduleId,
    "channels",
  );
}

function assertArray<TValue>(
  value: unknown,
  predicate: (item: unknown) => item is TValue,
  code: ModuleDiagnosticCode,
  message: string,
  moduleId: string,
  field: string,
): asserts value is TValue[] {
  if (!Array.isArray(value) || !value.every(predicate)) fail(code, message, moduleId, field);
}

function assertUnique(
  values: readonly string[],
  code: ModuleDiagnosticCode,
  label: string,
  moduleId: string,
  field: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(code, `duplicate ${label} ${JSON.stringify(value)}`, moduleId, field);
    seen.add(value);
  }
}

function fail(
  code: ModuleDiagnosticCode,
  message: string,
  moduleId?: string,
  field?: string,
): never {
  throw new InvalidModuleDefinitionError(code, message, { moduleId, field });
}
