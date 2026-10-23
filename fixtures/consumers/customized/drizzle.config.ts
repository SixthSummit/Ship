import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated from `src/schema.ts` (never hand-edited) and
 * applied only by the gated release step (`pnpm run db:release`), never at
 * boot. `schema.snapshot.json` records what they produce; CI fails on drift.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  strict: true,
});
