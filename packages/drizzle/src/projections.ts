import { DrizzleRepositoryError } from "./repository-error.js";

const PROJECTION_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/u;

export type RepositoryProjection = (...arguments_: never[]) => unknown;
export type RepositoryProjectionDefinitions = Readonly<Record<string, RepositoryProjection>>;

export interface RepositoryProjections<TDefinitions extends RepositoryProjectionDefinitions> {
  readonly kind: "ship.drizzle.repository-projections";
  readonly names: readonly (keyof TDefinitions & string)[];
  has(name: string): name is keyof TDefinitions & string;
  run<TKey extends keyof TDefinitions & string>(
    name: TKey,
    ...arguments_: Parameters<TDefinitions[TKey]>
  ): ReturnType<TDefinitions[TKey]>;
}

/**
 * Closes dynamic read shapes over a finite set of fully typed query functions.
 * A definition normally captures the transaction-scoped repository connection.
 */
export function defineRepositoryProjections<
  const TDefinitions extends RepositoryProjectionDefinitions,
>(definitions: TDefinitions): RepositoryProjections<TDefinitions> {
  if (typeof definitions !== "object" || definitions === null || Array.isArray(definitions)) {
    throw projectionsError("repository projections must be an object");
  }

  const entries = Object.entries(definitions).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw projectionsError("repository projections cannot be empty");

  for (const [name, projection] of entries) {
    if (!PROJECTION_NAME_PATTERN.test(name)) {
      throw projectionsError(
        `projection name must be a lower-camel identifier; received ${JSON.stringify(name)}`,
        name,
      );
    }
    if (typeof projection !== "function") {
      throw projectionsError(`projection ${JSON.stringify(name)} must be a function`, name);
    }
  }

  const registry = Object.freeze(Object.fromEntries(entries)) as TDefinitions;
  const names = Object.freeze(entries.map(([name]) => name)) as readonly (keyof TDefinitions &
    string)[];
  const has = (name: string): name is keyof TDefinitions & string => Object.hasOwn(registry, name);

  return Object.freeze({
    kind: "ship.drizzle.repository-projections" as const,
    names,
    has,
    run<TKey extends keyof TDefinitions & string>(
      name: TKey,
      ...arguments_: Parameters<TDefinitions[TKey]>
    ): ReturnType<TDefinitions[TKey]> {
      if (!has(name)) {
        throw new DrizzleRepositoryError(
          "SHIP_DRIZZLE_PROJECTION_UNKNOWN",
          `repository projection ${JSON.stringify(name)} is not declared`,
          { projection: name },
        );
      }
      const projection = registry[name];
      return projection(...arguments_) as ReturnType<TDefinitions[TKey]>;
    },
  });
}

function projectionsError(message: string, projection?: string): DrizzleRepositoryError {
  return new DrizzleRepositoryError("SHIP_DRIZZLE_PROJECTIONS_INVALID", message, { projection });
}
