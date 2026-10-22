import type { CanActivateFn, Routes } from '@angular/router';
import { ShipConsoleShellComponent } from './console-shell.component';
import { ShipConsoleCronPanelComponent } from './cron-panel.component';
import { ShipConsoleJobsPanelComponent } from './jobs-panel.component';
import { ShipConsoleOutboxPanelComponent } from './outbox-panel.component';
import { ShipConsoleRealtimePanelComponent } from './realtime-panel.component';
import { ShipConsoleWebhooksPanelComponent } from './webhooks-panel.component';

export interface ShipConsoleRoutesOptions {
  /**
   * Guards every console route runs. Required: the backend refuses callers
   * without `console.operate`, but the application decides who may even see
   * the panels (for example its signed-in guard).
   */
  readonly canActivate: readonly CanActivateFn[];
}

/**
 * Routes for the console, to mount as a child of an application route
 * (`{ path: 'console', children: shipConsoleRoutes({ canActivate }) }`) or as the
 * whole route table of a standalone console application.
 */
export function shipConsoleRoutes(options: ShipConsoleRoutesOptions): Routes {
  if (!Array.isArray(options?.canActivate) || options.canActivate.length === 0) {
    throw new TypeError('shipConsoleRoutes requires at least one canActivate guard');
  }
  const canActivate = [...options.canActivate];
  return [
    {
      path: '',
      component: ShipConsoleShellComponent,
      canActivate,
      children: [
        { path: 'jobs', component: ShipConsoleJobsPanelComponent, canActivate },
        { path: 'cron', component: ShipConsoleCronPanelComponent, canActivate },
        { path: 'webhooks', component: ShipConsoleWebhooksPanelComponent, canActivate },
        { path: 'realtime', component: ShipConsoleRealtimePanelComponent, canActivate },
        { path: 'outbox', component: ShipConsoleOutboxPanelComponent, canActivate },
      ],
    },
  ];
}
