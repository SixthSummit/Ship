import { defineConfig } from 'vitest/config';
import core from '../../../packages/angular/vitest.config.ts';
export default defineConfig({
  ...core,
  root: new URL('../../../packages/angular', import.meta.url).pathname,
  test: {
    ...core.test,
    include: ['../../angular/conformance/query-example/*.test.ts'],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      include: ['fixture.ts', 'workflow.ts', 'realtime.ts'].map(
        file => new URL(file, import.meta.url).pathname
      ),
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
