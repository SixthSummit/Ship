import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Root application component
 *
 * Renders the router outlet. Auth wiring happens via `provideAppInitializer`
 * in `app.config.ts`; functional `authGuard` protects routes that need it.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- i18n example: this label is extracted by 'pnpm i18n:extract'. -->
    <span i18n="@@app.skip-to-content" class="sr-only">Skip to main content</span>
    <router-outlet />
  `,
  styles: [],
})
export class AppComponent {}
