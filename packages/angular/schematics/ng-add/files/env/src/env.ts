import { z } from 'zod';
import { defineEnv } from '@SixthSummit/Ship';

/**
 * Zod-validated runtime env. The schema fails fast at module load if any
 * required env var is missing or malformed; the build won't even render
 * the broken state.
 *
 * Add fields here as you need them. Keep credentials in `.env` files
 * (gitignored) and read via `import.meta.env` (Vite) or `process.env`
 * (Node). The framework's `defineEnv()` validates whichever you pass in.
 *
 * @see https://github.com/SixthSummit/Ship/blob/v4/packages/core/src/env/defineEnv.ts
 */
const schema = z.object({
  production: z.boolean(),
  apiBase: z.string().min(1).default('/api'),
  firebase: z.object({
    apiKey: z.string().min(1).default('replace-me'),
    authDomain: z.string().min(1).default('replace-me'),
    projectId: z.string().min(1).default('replace-me'),
  }),
});

export const env = defineEnv(schema, {
  production: import.meta.env['PROD'] === true,
  apiBase: import.meta.env['VITE_API_BASE'],
  firebase: {
    apiKey: import.meta.env['VITE_FIREBASE_API_KEY'],
    authDomain: import.meta.env['VITE_FIREBASE_AUTH_DOMAIN'],
    projectId: import.meta.env['VITE_FIREBASE_PROJECT_ID'],
  },
});
