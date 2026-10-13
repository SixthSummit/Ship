/// <reference types="vitest" />

import angular from '@analogjs/vite-plugin-angular';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [angular()],
  // Scan test inputs, never generated SSR HTML left by a previous build.
  optimizeDeps: { entries: ['src/**/*.{spec,test}.ts'] },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.{spec,test}.ts'],
    exclude: ['node_modules/**', '**/node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.{spec,test}.ts',
        'src/test-setup.ts',
        'src/test-polyfills.ts',
        'src/**/index.ts',
        'src/main.ts',
        'src/environments/**',
      ],
    },
  },
});
