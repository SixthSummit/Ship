import { computed, signal } from '@angular/core';
import type { ShipConsoleClient } from './console-contract';
import type {
  ConsoleFailure,
  ConsoleJobsOverview,
  ConsoleOutboxes,
  ConsoleOutboxRecord,
  ConsoleOutboxRecordStatus,
  ConsoleOutboxRecords,
  ConsolePanels,
  ConsoleRealtime,
  ConsoleReceiptDetail,
  ConsoleReceiptQuery,
  ConsoleReceipts,
  ConsoleReplayed,
  ConsoleRun,
  ConsoleRunQuery,
  ConsoleSchedule,
  ConsoleTriggered,
} from './console-views';

export const DEFAULT_CONSOLE_PREFIX = 'console';

export interface ShipConsoleOptions {
  /** The operation client the application already provides (any `OperationClient`). */
  readonly client: ShipConsoleClient | (() => ShipConsoleClient);
  /** The console module id the operations are namespaced by. Defaults to `console`. */
  readonly prefix?: string;
}

/**
 * Signal-first client for one mounted console. Every method calls the
 * matching declared operation and keeps the latest value per panel; declared
 * failures (403 without `console.operate`, 501 for a missing adapter
 * capability, 404s) land in `failure` as values, never as thrown errors.
 */
export class ShipConsole {
  private readonly clientFactory: () => ShipConsoleClient;
  private readonly prefix: string;
  private readonly inFlight = signal(0);
  private readonly lastFailure = signal<ConsoleFailure | undefined>(undefined);
  private readonly panelsState = signal<ConsolePanels | undefined>(undefined);
  private readonly jobsState = signal<ConsoleJobsOverview | undefined>(undefined);
  private readonly runsState = signal<readonly ConsoleRun[]>([]);
  private readonly runState = signal<ConsoleRun | undefined>(undefined);
  private readonly schedulesState = signal<readonly ConsoleSchedule[]>([]);
  private readonly receiptsState = signal<ConsoleReceipts | undefined>(undefined);
  private readonly receiptState = signal<ConsoleReceiptDetail | undefined>(undefined);
  private readonly realtimeState = signal<ConsoleRealtime | undefined>(undefined);
  private readonly outboxesState = signal<ConsoleOutboxes | undefined>(undefined);
  private readonly outboxRecordsState = signal<ConsoleOutboxRecords | undefined>(undefined);

  readonly busy = computed(() => this.inFlight() > 0);
  readonly failure = this.lastFailure.asReadonly();
  readonly panels = this.panelsState.asReadonly();
  readonly jobs = this.jobsState.asReadonly();
  readonly runs = this.runsState.asReadonly();
  readonly run = this.runState.asReadonly();
  readonly schedules = this.schedulesState.asReadonly();
  readonly receipts = this.receiptsState.asReadonly();
  readonly receipt = this.receiptState.asReadonly();
  readonly realtime = this.realtimeState.asReadonly();
  readonly outboxes = this.outboxesState.asReadonly();
  readonly outboxRecords = this.outboxRecordsState.asReadonly();

  constructor(options: ShipConsoleOptions) {
    const { client } = options;
    this.clientFactory = typeof client === 'function' ? client : () => client;
    this.prefix = options.prefix ?? DEFAULT_CONSOLE_PREFIX;
  }

  /** The fully qualified operation id for a panel operation suffix. */
  operationId(suffix: string): string {
    return `${this.prefix}.${suffix}`;
  }

  clearFailure(): void {
    this.lastFailure.set(undefined);
  }

  async loadPanels(): Promise<ConsolePanels | undefined> {
    const data = await this.call<ConsolePanels>('panels', {});
    if (data) this.panelsState.set(data);
    return data;
  }

  async loadJobs(): Promise<ConsoleJobsOverview | undefined> {
    const data = await this.call<ConsoleJobsOverview>('jobs.overview', {});
    if (data) this.jobsState.set(data);
    return data;
  }

  async loadRuns(query: ConsoleRunQuery = {}): Promise<readonly ConsoleRun[] | undefined> {
    const data = await this.call<{ readonly runs: readonly ConsoleRun[] }>('jobs.runs', {
      query: compact(query),
    });
    if (data) this.runsState.set(data.runs);
    return data?.runs;
  }

  async loadRun(runId: string): Promise<ConsoleRun | undefined> {
    const data = await this.call<{ readonly run: ConsoleRun }>('jobs.run', { query: { runId } });
    if (data) this.runState.set(data.run);
    return data?.run;
  }

  async retry(runId: string): Promise<ConsoleRun | undefined> {
    const data = await this.call<{ readonly run: ConsoleRun }>('jobs.retry', { body: { runId } });
    if (data) this.replaceRun(data.run);
    return data?.run;
  }

  async discard(runId: string, reason: string): Promise<ConsoleRun | undefined> {
    const data = await this.call<{ readonly run: ConsoleRun }>('jobs.discard', {
      body: { runId, reason },
    });
    if (data) this.replaceRun(data.run);
    return data?.run;
  }

  async retryAll(jobId?: string, limit?: number): Promise<number | undefined> {
    const data = await this.call<{ readonly retried: number }>('jobs.retry-all', {
      body: compact({ jobId, limit }),
    });
    return data?.retried;
  }

  async pause(jobId: string): Promise<boolean | undefined> {
    const data = await this.call<{ readonly paused: boolean }>('jobs.pause', { body: { jobId } });
    if (data) this.markPaused(jobId, data.paused);
    return data?.paused;
  }

  async resume(jobId: string): Promise<boolean | undefined> {
    const data = await this.call<{ readonly paused: boolean }>('jobs.resume', { body: { jobId } });
    if (data) this.markPaused(jobId, data.paused);
    return data?.paused;
  }

  async loadSchedules(): Promise<readonly ConsoleSchedule[] | undefined> {
    const data = await this.call<{ readonly schedules: readonly ConsoleSchedule[] }>(
      'cron.schedules',
      {}
    );
    if (data) this.schedulesState.set(data.schedules);
    return data?.schedules;
  }

  async trigger(jobId: string): Promise<ConsoleTriggered | undefined> {
    return this.call<ConsoleTriggered>('cron.trigger', { body: { jobId } });
  }

  async loadReceipts(query: ConsoleReceiptQuery = {}): Promise<ConsoleReceipts | undefined> {
    const data = await this.call<ConsoleReceipts>('webhooks.receipts', { query: compact(query) });
    if (data) this.receiptsState.set(data);
    return data;
  }

  async loadReceipt(eventId: string): Promise<ConsoleReceiptDetail | undefined> {
    const data = await this.call<{ readonly receipt: ConsoleReceiptDetail }>('webhooks.receipt', {
      query: { eventId },
    });
    if (data) this.receiptState.set(data.receipt);
    return data?.receipt;
  }

  async replay(eventId: string): Promise<ConsoleReplayed | undefined> {
    return this.call<ConsoleReplayed>('webhooks.replay', { params: { eventId } });
  }

  async loadRealtime(): Promise<ConsoleRealtime | undefined> {
    const data = await this.call<ConsoleRealtime>('realtime.channels', {});
    if (data) this.realtimeState.set(data);
    return data;
  }

  async loadOutboxes(): Promise<ConsoleOutboxes | undefined> {
    const data = await this.call<ConsoleOutboxes>('outbox.overview', {});
    if (data) this.outboxesState.set(data);
    return data;
  }

  async loadOutboxRecords(
    outboxId: string,
    status?: ConsoleOutboxRecordStatus,
    limit?: number
  ): Promise<ConsoleOutboxRecords | undefined> {
    const data = await this.call<ConsoleOutboxRecords>('outbox.records', {
      query: compact({ outboxId, status, limit }),
    });
    if (data) this.outboxRecordsState.set(data);
    return data;
  }

  async retryRecord(outboxId: string, recordId: string): Promise<ConsoleOutboxRecord | undefined> {
    const data = await this.call<{ readonly record: ConsoleOutboxRecord }>('outbox.retry', {
      body: { outboxId, recordId },
    });
    if (data) this.replaceRecord(outboxId, data.record);
    return data?.record;
  }

  async discardRecord(
    outboxId: string,
    recordId: string,
    reason: string
  ): Promise<ConsoleOutboxRecord | undefined> {
    const data = await this.call<{ readonly record: ConsoleOutboxRecord }>('outbox.discard', {
      body: { outboxId, recordId, reason },
    });
    if (data) this.replaceRecord(outboxId, data.record);
    return data?.record;
  }

  private async call<TData>(suffix: string, input: unknown): Promise<TData | undefined> {
    const operation = this.operationId(suffix);
    this.inFlight.update(count => count + 1);
    try {
      const result = await this.clientFactory().call(operation, input);
      if (!result.ok) {
        this.lastFailure.set({
          operation,
          status: result.status,
          code: result.error.code,
          message: result.error.message,
        });
        return undefined;
      }
      this.lastFailure.set(undefined);
      return result.notModified ? undefined : (result.data as TData);
    } catch (error) {
      this.lastFailure.set({
        operation,
        status: 0,
        code: 'TRANSPORT_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      this.inFlight.update(count => count - 1);
    }
  }

  private replaceRun(run: ConsoleRun): void {
    this.runsState.update(runs => runs.map(item => (item.runId === run.runId ? run : item)));
    if (this.runState()?.runId === run.runId) this.runState.set(run);
  }

  private markPaused(jobId: string, paused: boolean): void {
    this.jobsState.update(overview =>
      overview
        ? {
            ...overview,
            jobs: overview.jobs.map(job => (job.jobId === jobId ? { ...job, paused } : job)),
          }
        : overview
    );
    this.schedulesState.update(schedules =>
      schedules.map(item => (item.jobId === jobId ? { ...item, paused } : item))
    );
  }

  private replaceRecord(outboxId: string, record: ConsoleOutboxRecord): void {
    this.outboxRecordsState.update(current =>
      current && current.outboxId === outboxId
        ? {
            ...current,
            records: current.records.map(item => (item.id === record.id ? record : item)),
          }
        : current
    );
  }
}

/** Drops `undefined` members so optional query and body fields are omitted, not sent as null. */
function compact<T extends object>(value: T): Partial<T> {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
}
