/**
 * MSW browser worker setup. Imported by `main.ts` when `VITE_MSW=true`.
 * In production, `main.ts` skips this import entirely.
 */
import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker = setupWorker(...handlers);
