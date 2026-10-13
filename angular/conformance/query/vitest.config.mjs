import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new globalThis.URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['conformance/query/**/*.test.mjs'],
    exclude: ['**/packed-candidate.test.mjs'],
    testTimeout: 3000,
    coverage: {
      provider: 'v8',
      include: ['conformance/query/*.mjs'],
      exclude: [
        '**/*.test.mjs',
        '**/run-archive.mjs',
        '**/*vitest.config.mjs',
        '**/candidate*.mjs',
        '**/run-browser.mjs',
      ],
      reporter: ['text', 'text-summary'],
      reportsDirectory: '/tmp/ship-query-conformance-coverage',
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
};
