import { defineConfig } from 'vitest/config';

// Schematics compile beside source as CommonJS. Resolve this coverage lane to the
// authored TypeScript while its Devkit fixture still verifies actual CommonJS factories.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^\.\/index$/,
        replacement: new URL('./schematics/operation-query/index.ts', import.meta.url).pathname,
      },
      {
        find: /^\.\/pin-query-dependency$/,
        replacement: new URL(
          './schematics/operation-query/pin-query-dependency.ts',
          import.meta.url
        ).pathname,
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['schematics/operation-query/*.test.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage-query-generator',
      include: [
        'schematics/operation-query/index.ts',
        'schematics/operation-query/pin-query-dependency.ts',
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
