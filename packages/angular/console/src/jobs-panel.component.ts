import { ChangeDetectionStrategy, Component, type OnInit, signal } from '@angular/core';
import { formatInstant, formatJson, formatTrigger } from './console-format';
import type { ConsoleRunStatus } from './console-views';
import { injectConsole } from './provide-ship-console';

const RUN_STATUSES: readonly ConsoleRunStatus[] = [
  'failed',
  'waiting',
  'delayed',
  'active',
  'completed',
  'discarded',
];

/** Queue depth per job, run listing by status, retry, discard, bulk retry, pause and resume. */
@Component({
  selector: 'ship-console-jobs-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ship-console__panel">
      <header class="ship-console__header">
        <h2>Jobs</h2>
        <button type="button" (click)="reload()">Refresh</button>
        @if (console.jobs(); as overview) {
          <small>adapter: {{ overview.capabilities.adapter }}</small>
        }
      </header>
      <table class="ship-console__table">
        <thead>
          <tr>
            <th>Job</th><th>Trigger</th><th>Waiting</th><th>Active</th><th>Delayed</th>
            <th>Failed</th><th>Lag (ms)</th><th>Last success</th><th></th>
          </tr>
        </thead>
        <tbody>
          @for (job of console.jobs()?.jobs ?? []; track job.jobId) {
            <tr [class.ship-console__row--paused]="job.paused">
              <td>{{ job.jobId }}@if (!job.declared) { <em>(undeclared)</em> }</td>
              <td>{{ trigger(job.trigger) }}</td>
              <td>{{ job.waiting }}</td>
              <td>{{ job.active }}</td>
              <td>{{ job.delayed }}</td>
              <td>
                {{ job.failed }}
                @if (job.failed > 0) {
                  <button type="button" (click)="retryAll(job.jobId)">Retry all</button>
                }
              </td>
              <td>{{ job.lagMs }}</td>
              <td>{{ instant(job.lastSuccessAt) }}</td>
              <td>
                <button type="button" (click)="showRuns(job.jobId)">Runs</button>
                @if (console.jobs()?.capabilities?.pause) {
                  @if (job.paused) {
                    <button type="button" (click)="console.resume(job.jobId)">Resume</button>
                  } @else {
                    <button type="button" (click)="console.pause(job.jobId)">Pause</button>
                  }
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="9">No jobs reported.</td></tr>
          }
        </tbody>
      </table>

      <header class="ship-console__header">
        <h3>Runs @if (jobId()) { for {{ jobId() }} }</h3>
        <label>
          Status
          <select [value]="status()" (change)="setStatus($event)">
            @for (option of statuses; track option) {
              <option [value]="option">{{ option }}</option>
            }
          </select>
        </label>
        @if (jobId()) {
          <button type="button" (click)="showRuns(undefined)">All jobs</button>
        }
      </header>
      <table class="ship-console__table">
        <thead>
          <tr><th>Run</th><th>Job</th><th>Status</th><th>Attempts</th><th>Input</th><th>Last error</th><th>Created</th><th></th></tr>
        </thead>
        <tbody>
          @for (run of console.runs(); track run.runId) {
            <tr>
              <td><code>{{ run.runId }}</code></td>
              <td>{{ run.jobId }}</td>
              <td>{{ run.status }}</td>
              <td>{{ run.attempts }}</td>
              <td><code>{{ json(run.input) }}</code></td>
              <td>{{ run.lastError ?? '—' }}</td>
              <td>{{ instant(run.createdAt) }}</td>
              <td>
                @if (run.status === 'failed') {
                  <button type="button" (click)="console.retry(run.runId)">Retry</button>
                  <button type="button" (click)="discard(run.runId)">Discard</button>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="8">No runs match.</td></tr>
          }
        </tbody>
      </table>
    </section>
  `,
  styles: `
    .ship-console__table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
    .ship-console__table th, .ship-console__table td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; vertical-align: top; }
    .ship-console__header { display: flex; align-items: center; gap: 0.75rem; }
    .ship-console__row--paused { opacity: 0.6; }
  `,
})
export class ShipConsoleJobsPanelComponent implements OnInit {
  readonly console = injectConsole();
  readonly statuses = RUN_STATUSES;
  readonly jobId = signal<string | undefined>(undefined);
  readonly status = signal<ConsoleRunStatus>('failed');
  readonly instant = formatInstant;
  readonly trigger = formatTrigger;
  readonly json = formatJson;

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    await this.console.loadJobs();
    await this.loadRuns();
  }

  async showRuns(jobId: string | undefined): Promise<void> {
    this.jobId.set(jobId);
    await this.loadRuns();
  }

  async setStatus(event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement | null)?.value;
    if (value && (RUN_STATUSES as readonly string[]).includes(value)) {
      this.status.set(value as ConsoleRunStatus);
      await this.loadRuns();
    }
  }

  async retryAll(jobId: string): Promise<void> {
    await this.console.retryAll(jobId);
    await this.reload();
  }

  async discard(runId: string): Promise<void> {
    await this.console.discard(runId, 'discarded from console');
  }

  private loadRuns(): Promise<unknown> {
    const jobId = this.jobId();
    return this.console.loadRuns({
      ...(jobId ? { jobId } : {}),
      status: this.status(),
      limit: 50,
    });
  }
}
