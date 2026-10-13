import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "cli/**/*.test.js"],
    // Exclude `*.integration.test.ts` — those require Docker
    // (testcontainers) and run via the dedicated
    // `vitest.integration.config.ts`. Keeping them out of the default
    // suite mirrors the root `vitest.config.ts` exclude pattern;
    // without this, `pnpm --filter @sixthsummit/ship-api test` would try to
    // start Postgres containers from the regular test loop.
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      // What we measure coverage against — the v4 framework source.
      // Explicit `include` keeps the report focused; without it, v8
      // walks every imported file (templates, fixtures, examples) and
      // dilutes the signal.
      include: ["src/**/*.ts"],
      // Excludes split into three groups:
      //   1. Test/fixture files (no value measuring tests-of-tests).
      //   2. Barrel files (pure re-exports — 0% line coverage by
      //      construction; nothing meaningful to test).
      //   3. Interface-only modules + real-DB integration glue
      //      (covered separately or no executable code to count).
      exclude: [
        // Tests + integration harness
        "**/*.test.ts",
        "**/*.integration.test.ts",
        "**/*.typecheck.ts",
        "src/test/**",
        // Framework barrel files (pure re-exports)
        "src/index.ts",
        "src/client.ts",
        "src/**/index.ts",
        // Type-only declaration files
        "src/**/*.d.ts",
        // Interface-only modules — runtime is just a contract
        // declaration; nothing to execute.
        "src/app/services/cache/Cache.ts",
        "src/app/services/storage/StorageService.ts",
        "src/app/services/rateLimit/RateLimitBackend.ts",
        // Real-DB integration glue — exercised by the testcontainers
        // integration suite (vitest.integration.config.ts), not the
        // unit suite. Mocking pg.Pool + drizzle to get unit coverage
        // would test the mock, not the integration.
        "src/app/db/client.ts",
      ],
      // Compatibility-package coverage uses the same 80% floor as the
      // repository-wide gate. Run the root `pnpm test:coverage` command for
      // the authoritative focused-package, compatibility, and library result.
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
