import type {
  DependencyBindings,
  DependencyToken,
  ResolveDependencyBindings,
} from "./dependency.js";
import { isDependencyToken } from "./dependency.js";

declare const providerValue: unique symbol;

export type ProviderLifetime = "singleton" | "operation";

export interface ProviderFactoryArguments<TDependencies extends DependencyBindings> {
  readonly services: ResolveDependencyBindings<TDependencies>;
}

export interface ProviderDefinition<
  TValue,
  TDependencies extends DependencyBindings,
  TLifetime extends ProviderLifetime,
> {
  readonly token: DependencyToken<TValue, unknown>;
  readonly dependencies: TDependencies;
  readonly lifetime: TLifetime;
  readonly create: (
    arguments_: ProviderFactoryArguments<TDependencies>,
  ) => TValue | Promise<TValue>;
}

export interface Provider<
  TValue,
  TDependencies extends DependencyBindings,
  TLifetime extends ProviderLifetime,
> extends ProviderDefinition<TValue, TDependencies, TLifetime> {
  readonly kind: "ship.provider";
  readonly [providerValue]?: TValue;
}

export interface AnyProvider {
  readonly kind: "ship.provider";
  readonly token: DependencyToken;
  readonly dependencies: DependencyBindings;
  readonly lifetime: ProviderLifetime;
  readonly create: (...arguments_: never[]) => unknown;
}

export type ProviderDiagnosticCode =
  | "SHIP_PROVIDER_DEFINITION_INVALID"
  | "SHIP_PROVIDER_TOKEN_INVALID"
  | "SHIP_PROVIDER_DEPENDENCY_INVALID"
  | "SHIP_PROVIDER_DEPENDENCY_DUPLICATE"
  | "SHIP_PROVIDER_LIFETIME_INVALID"
  | "SHIP_PROVIDER_FACTORY_INVALID";

export class InvalidProviderDefinitionError extends Error {
  readonly code: ProviderDiagnosticCode;
  readonly providerId?: string;
  readonly field?: string;

  constructor(
    code: ProviderDiagnosticCode,
    message: string,
    options: { readonly providerId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidProviderDefinitionError";
    this.code = code;
    this.providerId = options.providerId;
    this.field = options.field;
  }
}

export function defineProvider<
  TValue,
  const TDependencies extends DependencyBindings,
  const TLifetime extends ProviderLifetime,
>(
  definition: ProviderDefinition<TValue, TDependencies, TLifetime>,
): Provider<TValue, TDependencies, TLifetime> {
  assertProviderDefinition(definition);

  return Object.freeze({
    ...definition,
    kind: "ship.provider" as const,
    dependencies: Object.freeze({ ...definition.dependencies }),
  });
}

export function valueProvider<TValue>(
  token: DependencyToken<TValue, unknown>,
  value: TValue,
): Provider<TValue, Record<never, never>, "singleton"> {
  return defineProvider({
    token,
    dependencies: {},
    lifetime: "singleton",
    create: () => value,
  });
}

export function isProvider(value: unknown): value is AnyProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.provider" &&
    isDependencyToken(Reflect.get(value, "token")) &&
    typeof Reflect.get(value, "create") === "function"
  );
}

function assertProviderDefinition(
  definition: unknown,
): asserts definition is ProviderDefinition<unknown, DependencyBindings, ProviderLifetime> {
  if (typeof definition !== "object" || definition === null) {
    fail("SHIP_PROVIDER_DEFINITION_INVALID", "provider definition must be an object");
  }

  const token = Reflect.get(definition, "token");
  const providerId = isDependencyToken(token) ? token.id : undefined;
  if (!providerId) {
    fail(
      "SHIP_PROVIDER_TOKEN_INVALID",
      "provider token must be created with dependency()",
      undefined,
      "token",
    );
  }

  const dependencies = Reflect.get(definition, "dependencies");
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    fail(
      "SHIP_PROVIDER_DEPENDENCY_INVALID",
      "provider dependencies must be a map of dependency tokens",
      providerId,
      "dependencies",
    );
  }

  const dependencyIds = new Set<string>();
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name) || !isDependencyToken(dependency)) {
      fail(
        "SHIP_PROVIDER_DEPENDENCY_INVALID",
        `dependencies.${name} must be a valid dependency token`,
        providerId,
        `dependencies.${name}`,
      );
    }
    if (dependencyIds.has(dependency.id)) {
      fail(
        "SHIP_PROVIDER_DEPENDENCY_DUPLICATE",
        `dependency token ${JSON.stringify(dependency.id)} is bound more than once`,
        providerId,
        "dependencies",
      );
    }
    dependencyIds.add(dependency.id);
  }

  const lifetime = Reflect.get(definition, "lifetime");
  if (lifetime !== "singleton" && lifetime !== "operation") {
    fail(
      "SHIP_PROVIDER_LIFETIME_INVALID",
      "provider lifetime must be singleton or operation",
      providerId,
      "lifetime",
    );
  }

  if (typeof Reflect.get(definition, "create") !== "function") {
    fail(
      "SHIP_PROVIDER_FACTORY_INVALID",
      "provider create must be a function",
      providerId,
      "create",
    );
  }
}

function fail(
  code: ProviderDiagnosticCode,
  message: string,
  providerId?: string,
  field?: string,
): never {
  throw new InvalidProviderDefinitionError(code, message, { providerId, field });
}
