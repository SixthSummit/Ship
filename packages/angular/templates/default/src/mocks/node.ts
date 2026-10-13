/**
 * MSW Node setup. Used by vitest (jsdom environment) via `test-setup.ts`.
 * Not used at runtime — only for tests.
 */
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
