import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import shipAngular from '../packages/angular/eslint/index.js';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/node_modules/**',
      'packages/*/lib/**',
      'packages/*/templates/**',
      'libraries/**',
      // generated, do not lint
      'packages/angular/src/version.ts',
      // schematic templates carry <%= %> placeholders, not valid TS
      'packages/angular/schematics/**/files/**',
      // compiled schematic output — TS source is canonical
      'packages/angular/schematics/**/*.js',
      'packages/angular/schematics/**/*.d.ts',
      // Astro / Starlight docs site — built output and synced content are generated
      'apps/angular-docs/dist/**',
      'apps/angular-docs/.astro/**',
      'apps/angular-docs/src/content/docs/getting-started/**',
      'apps/angular-docs/src/content/docs/architecture/**',
      'apps/angular-docs/src/content/docs/development/**',
      'apps/angular-docs/src/content/docs/api/**',
      'apps/angular-docs/src/content/docs/guides/**',
      'apps/angular-docs/src/content/docs/evidence/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-debugger': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'none',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      '@typescript-eslint/ban-ts-comment': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  // This synthetic negative migration fixture deliberately loses its error cause.
  // The migration audit test must continue to identify that intentional defect.
  {
    files: [
      'angular/conformance/migration/synthetic-legacy/src/app/lib/core/api/client/ApiClient.ts',
    ],
    rules: { 'preserve-caught-error': 'off' },
  },
  // ShipAngular custom rules — Phase 1a flipped these from 'warn' to 'error'
  // once the framework code was migrated to inject() / OnPush / signal-first
  // / functional guards. Lint failures here are fix-the-code, not disable.
  {
    files: ['packages/angular/src/**/*.ts', 'packages/angular/*/src/**/*.ts', 'modules/**/*.ts'],
    plugins: { 'ship-angular': shipAngular },
    rules: {
      'ship-angular/use-inject': 'error',
      'ship-angular/onpush-required': 'error',
      'ship-angular/route-guard-or-public': 'error',
      'ship-angular/no-rxjs-in-public-api': 'error',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.type-test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'ship-angular/use-inject': 'off',
      'ship-angular/onpush-required': 'off',
    },
  },
];
