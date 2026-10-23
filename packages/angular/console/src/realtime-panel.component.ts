import { ChangeDetectionStrategy, Component, type OnInit } from '@angular/core';
import { formatInstant } from './console-format';
import { injectConsole } from './provide-ship-console';

/** Declared channels with the subscriber counts and last publish the backend observes. */
@Component({
  selector: 'ship-console-realtime-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ship-console__panel">
      <header class="ship-console__header">
        <h2>Realtime</h2>
        <button type="button" (click)="console.loadRealtime()">Refresh</button>
        @if (console.realtime(); as view) {
          <small>
            {{ view.backend.adapter }} {{ view.backend.ok ? 'ok' : 'unhealthy' }}
            @if (view.backend.detail) { — {{ view.backend.detail }} }
          </small>
        }
      </header>
      @if (console.realtime(); as view) {
        @if (!view.capabilities.introspection) {
          <p>The bound backend reports no subscriber counts.</p>
        }
        <table class="ship-console__table">
          <thead>
            <tr><th>Channel</th><th>Scope</th><th>Presence</th><th>Subscribers</th><th>Scopes</th><th>Last publish</th></tr>
          </thead>
          <tbody>
            @for (channel of view.channels; track channel.channelId) {
              <tr>
                <td>{{ channel.channelId }}</td>
                <td>{{ channel.scope }}</td>
                <td>{{ channel.presence ? 'yes' : 'no' }}</td>
                <td>{{ channel.subscribers ?? '—' }}</td>
                <td>{{ channel.scopes ?? '—' }}</td>
                <td>{{ instant(channel.lastPublishedAt) }}@if (channel.lastScopeKey) { ({{ channel.lastScopeKey }}) }</td>
              </tr>
            } @empty {
              <tr><td colspan="6">No channels declared.</td></tr>
            }
          </tbody>
        </table>
      }
    </section>
  `,
  styles: `
    .ship-console__table { width: 100%; border-collapse: collapse; }
    .ship-console__table th, .ship-console__table td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; }
    .ship-console__header { display: flex; align-items: center; gap: 0.75rem; }
  `,
})
export class ShipConsoleRealtimePanelComponent implements OnInit {
  readonly console = injectConsole();
  readonly instant = formatInstant;

  ngOnInit(): void {
    void this.console.loadRealtime();
  }
}
