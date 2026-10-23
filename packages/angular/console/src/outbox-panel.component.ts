import { ChangeDetectionStrategy, Component, type OnInit, signal } from '@angular/core';
import { formatInstant, formatJson } from './console-format';
import type { ConsoleOutboxRecordStatus } from './console-views';
import { injectConsole } from './provide-ship-console';

const RECORD_STATUSES: readonly ConsoleOutboxRecordStatus[] = [
  'dead-lettered',
  'pending',
  'claimed',
  'completed',
  'discarded',
];

/** Pending, leased and dead-lettered counts per outbox; record inspection, retry and discard. */
@Component({
  selector: 'ship-console-outbox-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ship-console__panel">
      <header class="ship-console__header">
        <h2>Outbox</h2>
        <button type="button" (click)="console.loadOutboxes()">Refresh</button>
      </header>
      <table class="ship-console__table">
        <thead>
          <tr><th>Outbox</th><th>Intents</th><th>Pending</th><th>Leased</th><th>Dead-lettered</th><th>Oldest pending</th><th></th></tr>
        </thead>
        <tbody>
          @for (outbox of console.outboxes()?.outboxes ?? []; track outbox.outboxId) {
            <tr>
              <td>{{ outbox.outboxId }}</td>
              <td>{{ outbox.intents.join(', ') }}</td>
              <td>{{ outbox.pending }}</td>
              <td>{{ outbox.claimed }}</td>
              <td>{{ outbox.deadLettered }}</td>
              <td>{{ instant(outbox.oldestPendingAt) }}</td>
              <td><button type="button" (click)="inspect(outbox.outboxId)">Records</button></td>
            </tr>
          } @empty {
            <tr><td colspan="7">No outboxes mounted.</td></tr>
          }
        </tbody>
      </table>
      @if (outboxId(); as selected) {
        <header class="ship-console__header">
          <h3>{{ selected }}</h3>
          <label>
            Status
            <select [value]="status()" (change)="setStatus($event)">
              @for (option of statuses; track option) {
                <option [value]="option">{{ option }}</option>
              }
            </select>
          </label>
        </header>
        <table class="ship-console__table">
          <thead>
            <tr><th>Record</th><th>Intent</th><th>Status</th><th>Attempts</th><th>Payload</th><th>Last error</th><th>Available</th><th></th></tr>
          </thead>
          <tbody>
            @for (record of console.outboxRecords()?.records ?? []; track record.id) {
              <tr>
                <td><code>{{ record.id }}</code></td>
                <td>{{ record.intentId }}</td>
                <td>{{ record.status }}</td>
                <td>{{ record.attempts }}</td>
                <td><code>{{ json(record.payload) }}</code></td>
                <td>{{ record.lastError ?? '—' }}</td>
                <td>{{ instant(record.availableAt) }}</td>
                <td>
                  @if (record.status === 'dead-lettered') {
                    <button type="button" (click)="console.retryRecord(selected, record.id)">Retry</button>
                    <button type="button" (click)="discard(selected, record.id)">Discard</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="8">No records with this status.</td></tr>
            }
          </tbody>
        </table>
      }
    </section>
  `,
  styles: `
    .ship-console__table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
    .ship-console__table th, .ship-console__table td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; vertical-align: top; }
    .ship-console__header { display: flex; align-items: center; gap: 0.75rem; }
  `,
})
export class ShipConsoleOutboxPanelComponent implements OnInit {
  readonly console = injectConsole();
  readonly statuses = RECORD_STATUSES;
  readonly outboxId = signal<string | undefined>(undefined);
  readonly status = signal<ConsoleOutboxRecordStatus>('dead-lettered');
  readonly instant = formatInstant;
  readonly json = formatJson;

  ngOnInit(): void {
    void this.console.loadOutboxes();
  }

  async inspect(outboxId: string): Promise<void> {
    this.outboxId.set(outboxId);
    await this.console.loadOutboxRecords(outboxId, this.status(), 50);
  }

  async setStatus(event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement | null)?.value;
    const outboxId = this.outboxId();
    if (value && outboxId && (RECORD_STATUSES as readonly string[]).includes(value)) {
      this.status.set(value as ConsoleOutboxRecordStatus);
      await this.console.loadOutboxRecords(outboxId, this.status(), 50);
    }
  }

  async discard(outboxId: string, recordId: string): Promise<void> {
    await this.console.discardRecord(outboxId, recordId, 'discarded from console');
  }
}
