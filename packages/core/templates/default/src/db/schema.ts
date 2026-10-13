/**
 * Composed database schema — single source of truth for both:
 *   1. The runtime via `createDb({ config, schema })` in `src/index.ts`.
 *   2. The migration tooling via `drizzle.config.ts` (`schema:
 *      "./src/db/schema.ts"`).
 *
 * The framework ships no default tables — identity/RBAC lives in the
 * `accounts` module (add it with `ship-api add accounts`). Compose each
 * module's exported schema fragment here, then add your own module tables.
 * For example, after `ship-api add accounts`:
 *
 *   import { accountsSchema } from "../modules/accounts/index.js";
 *   export const schema = { ...accountsSchema, ...yourTables };
 */

// Compose module schema fragments as you add them:
// import { accountsSchema } from "../modules/accounts/index.js"; // ship-api add accounts
// import { posts, postsRelations } from "../modules/posts/schema.js"; // ship-api g resource posts

export const schema = {
  // ...accountsSchema,
  // posts,
  // postsRelations,
};

export type Schema = typeof schema;
