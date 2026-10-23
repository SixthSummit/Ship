import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ShipConsoleShellComponent } from './console-shell.component';
import { provideShipConsole } from './provide-ship-console';
import { shipConsoleRoutes } from './ship-console.routes';

describe('ShipConsoleShellComponent', () => {
  it('lists only the panels the backend mounted and surfaces a refused call', async () => {
    const call = vi.fn(async (operation: string) =>
      operation === 'console.panels'
        ? {
            ok: true as const,
            status: 200,
            data: {
              id: 'console',
              basePath: '/console',
              permission: 'console.operate',
              panels: [
                { id: 'jobs', title: 'Jobs', operations: [] },
                { id: 'outbox', title: 'Outbox', operations: [] },
              ],
            },
          }
        : { ok: false as const, status: 403, error: { code: 'AUTHORIZATION_ERROR', message: 'no' } }
    );
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter(shipConsoleRoutes({ canActivate: [() => true] })),
        provideShipConsole({ client: { call } }),
      ],
    });
    const fixture = TestBed.createComponent(ShipConsoleShellComponent);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const links = [...element.querySelectorAll('a')].map(a => a.textContent?.trim());
    expect(links).toEqual(['Jobs', 'Outbox']);

    const console = fixture.componentInstance.console;
    await console.loadJobs();
    await fixture.whenStable();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('AUTHORIZATION_ERROR');
  });
});
