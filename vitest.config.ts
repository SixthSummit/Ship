import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.js",
      "packages/*/cli/**/*.test.js",
      "scripts/**/*.test.mjs",
      "modules/**/*.test.ts",
      "libraries/**/*.test.ts",
    ],
    exclude: [
      "packages/angular/**",
      "node_modules/**",
      "**/node_modules/**",
      "packages/*/lib/**",
      "**/*.integration.test.ts",
      "**/*.parity.test.ts",
    ],
    globals: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["packages/*/src/**/*.{ts,js}", "libraries/**/*.ts"],
      exclude: [
        "packages/angular/**",
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/*.test.js",
        "packages/*/src/**/*.integration.test.ts",
        "packages/*/src/**/*.typecheck.ts",
        "packages/*/src/**/__fixtures__/**",
        "packages/*/src/**/index.ts",
        "libraries/**/*.test.ts",
        "libraries/**/*.example.ts",
        "libraries/**/index.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
