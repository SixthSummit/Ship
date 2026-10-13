import { defineConfig } from "vitest/config";

/**
 * Root parity-test config (A2-6) — the v3↔v4 behavioral-parity suite.
 *
 * Separate from the unit config (`vitest.config.ts` *excludes* `*.parity.test.ts`)
 * so the differential fixtures are a distinct gate. Unlike the integration
 * config it needs no Docker — parity fixtures run in-process via Hono's
 * `app.request()`, so this is fast.
 *
 * Runs two fixture kinds (see docs/v4/tooling/parity-harness.md):
 *   - `v4-conformance` — lock v4's documented contracts today (ship with the framework).
 *   - `v3-capture` — recorded from a live v3 app (the wasting-asset oracle); consumers
 *     add these in their migrated app to assert the v4 build matches v3 behavior.
 *
 * Run via:  pnpm run test:parity
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.parity.test.ts", "modules/**/*.parity.test.ts"],
    exclude: ["node_modules/**", "**/node_modules/**", "packages/*/lib/**"],
    globals: true,
  },
});
