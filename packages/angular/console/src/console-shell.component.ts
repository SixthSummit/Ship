import { ChangeDetectionStrategy, Component, type OnInit } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { injectConsole } from './provide-ship-console';

/**
 * Navigation plus outlet for the mounted panels. The panel list comes from
 * `console.panels`, so only what the backend mounted is offered.
 */
@Component({
  selector: 'ship-console-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ship-console' },
  template: `
    <nav class="ship-console__nav" aria-label="Console panels">
      @for (panel of console.panels()?.panels ?? []; track panel.id) {
        <a
          class="ship-console__link"
          [routerLink]="[panel.id]"
          routerLinkActive="ship-console__link--active"
          >{{ panel.title }}</a
        >
      }
      @if (console.busy()) {
        <span class="ship-console__busy" aria-live="polite">Loading…</span>
      }
    </nav>
    @if (console.failure(); as failure) {
      <p class="ship-console__failure" role="alert">
        {{ failure.operation }} failed: {{ failure.code }} ({{ failure.status }})
        {{ failure.message }}
        <button type="button" (click)="console.clearFailure()">Dismiss</button>
      </p>
    }
    <router-outlet />
  `,
  styles: `
    :host { display: block; font: 14px/1.4 system-ui, sans-serif; }
    .ship-console__nav { display: flex; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid #ddd; }
    .ship-console__link--active { font-weight: 600; text-decoration: underline; }
    .ship-console__failure { padding: 0.5rem; border: 1px solid #c33; color: #c33; }
    .ship-console__busy { margin-left: auto; opacity: 0.6; }
  `,
})
export class ShipConsoleShellComponent implements OnInit {
  readonly console = injectConsole();

  ngOnInit(): void {
    void this.console.loadPanels();
  }
}
