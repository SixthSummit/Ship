import { defineConfig } from "vitest/config";

/**
 * Integration-test vitest config — kept separate from the default
 * `vitest.config.ts` so the regular `pnpm test` loop stays fast and
 * Docker-free. Integration tests under `*.integration.test.ts`
 * spin up Postgres containers via `@testcontainers/postgresql`;
 * each test file's container start adds a few seconds to wall-clock
 * runtime, so we run them on demand or in a dedicated CI job.
 *
 * Run via:
 *   pnpm --filter @sixthsummit/ship-api test:integration
 *
 * Prerequisites: Docker daemon running on the host. CI's
 * `ubuntu-latest` runners include Docker; local devs without Docker
 * still get the full unit-test suite via the default `pnpm test`.
 */
export default defineConfig({
  test: {
    environment: "node",
    // Match ONLY `*.integration.test.ts` files. Fake-DB unit tests
    // under `src/test/integration/*.test.ts` (me-reference,
    // all-modules) are convention-named "integration" because they
    // exercise the cross-module composition through the full
    // middleware chain — but they're Docker-free and run in the
    // default `pnpm test` suite.
    include: ["src/**/*.integration.test.ts"],
    globals: true,
    // Container start + push-schema is ~5–15 s on first run; warm
    // local Docker is ~3 s. Default 5 s vitest hook timeout would
    // flake the first run on most machines.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
