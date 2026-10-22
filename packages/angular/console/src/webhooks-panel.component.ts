import { ChangeDetectionStrategy, Component, type OnInit, signal } from '@angular/core';
import { formatInstant } from './console-format';
import { injectConsole } from './provide-ship-console';

/** Receipts per endpoint with the record each one spawned, recent outcomes, detail and replay. */
@Component({
  selector: 'ship-console-webhooks-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ship-console__panel">
      <header class="ship-console__header">
        <h2>Webhooks</h2>
        <label>
          Endpoint
          <select [value]="webhookId() ?? ''" (change)="setWebhook($event)">
            <option value="">all</option>
            @for (hook of console.receipts()?.webhooks ?? []; track hook.id) {
              <option [value]="hook.id">{{ hook.id }} ({{ hook.provider }}, {{ hook.mode }})</option>
            }
          </select>
        </label>
        <button type="button" (click)="reload()">Refresh</button>
      </header>
      @if (console.receipts(); as view) {
        @if (!view.capabilities.list) {
          <p>The bound event store does not list receipts; detail and replay by event id still work.</p>
        }
        <table class="ship-console__table">
          <thead>
            <tr><th>Received</th><th>Endpoint</th><th>Provider event</th><th>Bytes</th><th>Dispatch</th><th></th></tr>
          </thead>
          <tbody>
            @for (receipt of view.receipts; track receipt.eventId) {
              <tr>
                <td>{{ instant(receipt.receivedAt) }}</td>
                <td>{{ receipt.webhookId }}</td>
                <td>{{ receipt.providerEventId ?? receipt.eventId }}</td>
                <td>{{ receipt.bytes }}</td>
                <td>
                  @if (receipt.dispatch; as dispatch) {
                    {{ dispatch.status }} ({{ dispatch.attempts }} attempts)
                    @if (dispatch.lastError) { — {{ dispatch.lastError }} }
                  } @else {
                    —
                  }
                </td>
                <td>
                  <button type="button" (click)="console.loadReceipt(receipt.eventId)">Detail</button>
                  <button type="button" (click)="replay(receipt.eventId)">Replay</button>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6">No stored receipts.</td></tr>
            }
          </tbody>
        </table>
        @if (view.capabilities.observed) {
          <h3>Recent outcomes (this process)</h3>
          <ul class="ship-console__observed">
            @for (item of view.observed; track $index) {
              <li>{{ instant(item.at) }} {{ item.webhookId }}: {{ item.outcome }} {{ item.status }}@if (item.reason) { ({{ item.reason }}) }</li>
            } @empty {
              <li>Nothing observed yet.</li>
            }
          </ul>
        }
      }
      @if (replayed(); as last) {
        <p>Replayed {{ last.eventId }}: {{ last.queued ? 'queued' : 'already pending' }}</p>
      }
      @if (console.receipt(); as detail) {
        <article class="ship-console__detail">
          <h3>Receipt {{ detail.eventId }}</h3>
          <dl>
            <dt>Request</dt><dd>{{ detail.requestId }}</dd>
            <dt>Content type</dt><dd>{{ detail.contentType ?? '—' }}</dd>
            <dt>Headers</dt>
            <dd>
              @for (header of headers(detail.headers); track header[0]) {
                <code>{{ header[0] }}: {{ header[1] }}</code><br />
              }
            </dd>
          </dl>
          @if (detail.bodyText !== undefined) {
            <pre class="ship-console__body">{{ detail.bodyText }}</pre>
          } @else {
            <p>Body not previewable ({{ detail.bytes }} bytes).</p>
          }
        </article>
      }
    </section>
  `,
  styles: `
    .ship-console__table { width: 100%; border-collapse: collapse; }
    .ship-console__table th, .ship-console__table td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; }
    .ship-console__header { display: flex; align-items: center; gap: 0.75rem; }
    .ship-console__body { max-height: 20rem; overflow: auto; background: #f6f6f6; padding: 0.5rem; }
  `,
})
export class ShipConsoleWebhooksPanelComponent implements OnInit {
  readonly console = injectConsole();
  readonly webhookId = signal<string | undefined>(undefined);
  readonly replayed = signal<{ readonly eventId: string; readonly queued: boolean } | undefined>(
    undefined
  );
  readonly instant = formatInstant;

  ngOnInit(): void {
    void this.reload();
  }

  reload(): Promise<unknown> {
    const webhookId = this.webhookId();
    return this.console.loadReceipts({ ...(webhookId ? { webhookId } : {}), limit: 50 });
  }

  async setWebhook(event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement | null)?.value;
    this.webhookId.set(value ? value : undefined);
    await this.reload();
  }

  async replay(eventId: string): Promise<void> {
    const result = await this.console.replay(eventId);
    if (result) this.replayed.set(result);
    await this.reload();
  }

  headers(value: Readonly<Record<string, string>>): readonly (readonly [string, string])[] {
    return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  }
}
