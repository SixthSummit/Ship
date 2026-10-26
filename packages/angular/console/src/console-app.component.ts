import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Root component for a console deployed as its own application next to the
 * API: `bootstrapApplication(ShipConsoleAppComponent, { providers:
 * [provideRouter(shipConsoleRoutes({ canActivate })), provideShipConsole({ client })] })`.
 */
@Component({
  selector: 'ship-console-app',
  standalone: true,
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet />`,
})
export class ShipConsoleAppComponent {}
