/**
 * MSW request handlers for development and tests.
 *
 * Add new handlers here to mock API endpoints. Vitest picks these up
 * automatically via `test-setup.ts`. The dev server picks them up when
 * `VITE_MSW=true` is set in `.env.development` (see `main.ts`).
 *
 * @see https://mswjs.io/docs/getting-started
 */
import { HttpResponse, http } from 'msw';

export const handlers = [
  // Example: a fake users endpoint your modules can develop against
  // when no backend is running. Delete or replace with your real shape.
  http.get('/api/users', () => {
    return HttpResponse.json([
      { id: '1', name: 'Alice', email: 'alice@example.test' },
      { id: '2', name: 'Bob', email: 'bob@example.test' },
    ]);
  }),
];
