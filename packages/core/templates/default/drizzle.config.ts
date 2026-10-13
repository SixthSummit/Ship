import { defineConfig } from "drizzle-kit";
import { env } from "./src/environment.js";

/**
 * Drizzle Kit config — drives the migration tooling
 * (`db:push`, `db:generate`, `db:migrate`, `db:studio`,
 * `db:baseline`).
 *
 * The schema source aggregates the module-owned tables the consumer
 * composes (identity/RBAC lives in the `accounts` module — add it with
 * `ship-api add accounts`) — the same import graph the runtime sees via
 * `createDb({ config, schema })` in `src/index.ts`. Single source of truth,
 * never drift between "what the app uses at runtime" and "what
 * migrations target".
 *
 * NEVER hand-edit the emitted SQL files in `src/db/migrations/`.
 * The next `db:generate` will overwrite or break history. Edit
 * the schema source and re-generate.
 */

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  // Verbose output makes `db:generate --name <description>` more
  // informative when reviewing diffs in PR.
  verbose: true,
  // Prompt before applying destructive operations (column drops,
  // type changes that need cast). Skip with --yes for CI.
  strict: true,
});
