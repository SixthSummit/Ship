import { describe, expect, it } from 'vitest';
import { shipConsoleRoutes } from './ship-console.routes';

describe('shipConsoleRoutes', () => {
  it('guards the shell and every panel with the supplied guards', () => {
    const guard = () => true;
    const routes = shipConsoleRoutes({ canActivate: [guard] });
    expect(routes[0]?.canActivate).toEqual([guard]);
    const children = routes[0]?.children ?? [];
    expect(children.map(route => route.path)).toEqual([
      'jobs',
      'cron',
      'webhooks',
      'realtime',
      'outbox',
    ]);
    for (const child of children) expect(child.canActivate).toEqual([guard]);
  });

  it('refuses an unguarded mount', () => {
    expect(() => shipConsoleRoutes({ canActivate: [] })).toThrow(TypeError);
  });
});
