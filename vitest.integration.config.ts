import { defineConfig } from "vitest/config";

/**
 * Root integration-test config — covers `*.integration.test.ts` across the
 * packages, modules, and libraries trees.
 *
 * Kept separate from the unit config (`vitest.config.ts`, which *excludes*
 * `*.integration.test.ts`) because these spin up Docker containers via
 * `@testcontainers/*`; each container start adds a few seconds, so they run
 * on demand or in the dedicated CI `integration-tests` job — not the fast,
 * Docker-free `pnpm test` loop.
 *
 * This mirrors `packages/core/vitest.integration.config.ts` but at repo scope,
 * so module and library integration tests have a runner when they land — e.g.
 * A2-1a relocates the accounts/oauth integration tests out of
 * `packages/core/src/test/integration/` and into their modules.
 *
 * Run via:
 *   pnpm run test:integration        (Docker daemon required)
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.integration.test.ts",
      "modules/**/*.integration.test.ts",
      "libraries/**/*.integration.test.ts",
    ],
    exclude: ["node_modules/**", "**/node_modules/**", "packages/*/lib/**"],
    globals: true,
    // Container start + push-schema is ~5–15 s cold, ~3 s warm; the default
    // 5 s vitest hook timeout would flake the first run on most machines.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
