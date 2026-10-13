import { fileURLToPath } from 'node:url';
export default {
  root: fileURLToPath(new globalThis.URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['packed-candidate.test.mjs'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['candidate*.mjs'],
      exclude: [],
      reporter: ['text', 'text-summary', 'json-summary'],
      reportsDirectory: './candidate-coverage',
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80, perFile: true },
    },
  },
};
