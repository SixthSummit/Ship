import { ChangeDetectionStrategy, Component, type OnInit, signal } from '@angular/core';
import { formatInstant, formatTrigger } from './console-format';
import { injectConsole } from './provide-ship-console';

/** Every declared schedule with its next and last run, and a trigger-now per job. */
@Component({
  selector: 'ship-console-cron-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ship-console__panel">
      <header class="ship-console__header">
        <h2>Cron</h2>
        <button type="button" (click)="reload()">Refresh</button>
        @if (triggered(); as last) {
          <small>triggered {{ last.jobId }} as <code>{{ last.runId }}</code>@if (last.deduplicated) { (already queued) }</small>
        }
      </header>
      <table class="ship-console__table">
        <thead>
          <tr><th>Job</th><th>Schedule</th><th>Next</th><th>Last run</th><th>Last success</th><th>State</th><th></th></tr>
        </thead>
        <tbody>
          @for (schedule of console.schedules(); track schedule.jobId) {
            <tr>
              <td>{{ schedule.jobId }}</td>
              <td>{{ trigger(schedule.trigger) }}</td>
              <td>{{ instant(schedule.nextAt) }}@if (!schedule.reconciled) { <em>(not reconciled)</em> }</td>
              <td>{{ instant(schedule.lastRunAt) }}</td>
              <td>{{ instant(schedule.lastSuccessAt) }}</td>
              <td>{{ schedule.paused ? 'paused' : 'active' }}</td>
              <td><button type="button" (click)="trigger_(schedule.jobId)">Trigger now</button></td>
            </tr>
          } @empty {
            <tr><td colspan="7">No scheduled jobs.</td></tr>
          }
        </tbody>
      </table>
    </section>
  `,
  styles: `
    .ship-console__table { width: 100%; border-collapse: collapse; }
    .ship-console__table th, .ship-console__table td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; }
    .ship-console__header { display: flex; align-items: center; gap: 0.75rem; }
  `,
})
export class ShipConsoleCronPanelComponent implements OnInit {
  readonly console = injectConsole();
  readonly triggered = signal<
    { readonly jobId: string; readonly runId: string; readonly deduplicated: boolean } | undefined
  >(undefined);
  readonly instant = formatInstant;
  readonly trigger = formatTrigger;

  ngOnInit(): void {
    void this.reload();
  }

  reload(): Promise<unknown> {
    return this.console.loadSchedules();
  }

  async trigger_(jobId: string): Promise<void> {
    const result = await this.console.trigger(jobId);
    if (result) this.triggered.set(result);
  }
}
