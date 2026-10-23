import type {
  ConsoleJobsOverview,
  ConsoleOutboxes,
  ConsoleOutboxRecord,
  ConsoleOutboxRecordStatus,
  ConsoleOutboxRecords,
  ConsolePanels,
  ConsoleRealtime,
  ConsoleReceiptDetail,
  ConsoleReceipts,
  ConsoleReplayed,
  ConsoleRun,
  ConsoleRunStatus,
  ConsoleSchedule,
  ConsoleTriggered,
} from './console-views';

/** Framework codes the generated HTTP client adds to every console operation. */
export type ConsoleFrameworkErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'INTERNAL_SERVER_ERROR'
  | 'AUTHENTICATION_UNAVAILABLE';

type ConsoleSuccessResult<TSuccess extends object> = {
  readonly [TStatus in keyof TSuccess]: TStatus extends number
    ? { readonly ok: true; readonly status: TStatus; readonly data: TSuccess[TStatus] }
    : never;
}[keyof TSuccess];

type ConsoleFailureResult<TCode extends string> = {
  readonly ok: false;
  readonly status: number;
  readonly error: { readonly code: TCode; readonly message: string };
};

/**
 * One console operation in the canonical generated-contract shape
 * (`{ transport, input, result }`) the structural operation client reads.
 */
export interface ConsoleOperation<
  TInput,
  TSuccess extends object,
  TErrors extends string = ConsoleFrameworkErrorCode,
> {
  readonly transport: 'http';
  readonly input: TInput;
  readonly result:
    | ConsoleSuccessResult<TSuccess>
    | ConsoleFailureResult<TErrors | ConsoleFrameworkErrorCode>;
}

type NoInput = Record<string, never>;

/**
 * The structural contract of a `defineConsoleModule()` mounted with the
 * default `console` id. Type an operation client against it
 * (`OperationClient<ShipConsoleContract>`) and pass it to
 * {@link provideShipConsole}; a module mounted under another id uses the
 * `prefix` option and the untyped {@link ShipConsoleClient}.
 */
export interface ShipConsoleContract {
  readonly operations: {
    readonly 'console.panels': ConsoleOperation<NoInput, { readonly 200: ConsolePanels }>;
    readonly 'console.jobs.overview': ConsoleOperation<
      NoInput,
      { readonly 200: ConsoleJobsOverview }
    >;
    readonly 'console.jobs.runs': ConsoleOperation<
      {
        readonly query: {
          readonly jobId?: string;
          readonly status?: ConsoleRunStatus;
          readonly limit?: number;
        };
      },
      { readonly 200: { readonly runs: readonly ConsoleRun[] } },
      'CONSOLE_CAPABILITY_UNAVAILABLE'
    >;
    readonly 'console.jobs.run': ConsoleOperation<
      { readonly query: { readonly runId: string } },
      { readonly 200: { readonly run: ConsoleRun } },
      'CONSOLE_CAPABILITY_UNAVAILABLE' | 'JOB_RUN_NOT_FOUND'
    >;
    readonly 'console.jobs.retry': ConsoleOperation<
      { readonly body: { readonly runId: string } },
      { readonly 200: { readonly run: ConsoleRun } },
      'JOB_RUN_NOT_FOUND'
    >;
    readonly 'console.jobs.discard': ConsoleOperation<
      { readonly body: { readonly runId: string; readonly reason: string } },
      { readonly 200: { readonly run: ConsoleRun } },
      'JOB_RUN_NOT_FOUND'
    >;
    readonly 'console.jobs.retry-all': ConsoleOperation<
      { readonly body: { readonly jobId?: string; readonly limit?: number } },
      { readonly 200: { readonly retried: number; readonly runIds: readonly string[] } }
    >;
    readonly 'console.jobs.pause': ConsoleOperation<
      { readonly body: { readonly jobId: string } },
      { readonly 200: { readonly jobId: string; readonly paused: boolean } },
      'CONSOLE_CAPABILITY_UNAVAILABLE' | 'CONSOLE_JOB_NOT_FOUND'
    >;
    readonly 'console.jobs.resume': ConsoleOperation<
      { readonly body: { readonly jobId: string } },
      { readonly 200: { readonly jobId: string; readonly paused: boolean } },
      'CONSOLE_CAPABILITY_UNAVAILABLE' | 'CONSOLE_JOB_NOT_FOUND'
    >;
    readonly 'console.cron.schedules': ConsoleOperation<
      NoInput,
      { readonly 200: { readonly schedules: readonly ConsoleSchedule[] } },
      'CONSOLE_CAPABILITY_UNAVAILABLE'
    >;
    readonly 'console.cron.trigger': ConsoleOperation<
      { readonly body: { readonly jobId: string } },
      { readonly 202: ConsoleTriggered },
      'CONSOLE_CAPABILITY_UNAVAILABLE' | 'CONSOLE_SCHEDULE_NOT_FOUND' | 'CONSOLE_QUEUE_FULL'
    >;
    readonly 'console.webhooks.receipts': ConsoleOperation<
      {
        readonly query: {
          readonly webhookId?: string;
          readonly before?: string;
          readonly limit?: number;
        };
      },
      { readonly 200: ConsoleReceipts },
      'CONSOLE_CAPABILITY_UNAVAILABLE'
    >;
    readonly 'console.webhooks.receipt': ConsoleOperation<
      { readonly query: { readonly eventId: string } },
      { readonly 200: { readonly receipt: ConsoleReceiptDetail } },
      'WEBHOOK_EVENT_NOT_FOUND'
    >;
    readonly 'console.webhooks.replay': ConsoleOperation<
      { readonly params: { readonly eventId: string } },
      { readonly 200: ConsoleReplayed },
      'WEBHOOK_EVENT_NOT_FOUND'
    >;
    readonly 'console.realtime.channels': ConsoleOperation<
      NoInput,
      { readonly 200: ConsoleRealtime }
    >;
    readonly 'console.outbox.overview': ConsoleOperation<
      NoInput,
      { readonly 200: ConsoleOutboxes }
    >;
    readonly 'console.outbox.records': ConsoleOperation<
      {
        readonly query: {
          readonly outboxId: string;
          readonly status?: ConsoleOutboxRecordStatus;
          readonly limit?: number;
        };
      },
      { readonly 200: ConsoleOutboxRecords },
      'CONSOLE_OUTBOX_NOT_FOUND' | 'CONSOLE_CAPABILITY_UNAVAILABLE'
    >;
    readonly 'console.outbox.retry': ConsoleOperation<
      { readonly body: { readonly outboxId: string; readonly recordId: string } },
      { readonly 200: { readonly outboxId: string; readonly record: ConsoleOutboxRecord } },
      'CONSOLE_OUTBOX_NOT_FOUND' | 'OUTBOX_RECORD_NOT_FOUND'
    >;
    readonly 'console.outbox.discard': ConsoleOperation<
      {
        readonly body: {
          readonly outboxId: string;
          readonly recordId: string;
          readonly reason: string;
        };
      },
      { readonly 200: { readonly outboxId: string; readonly record: ConsoleOutboxRecord } },
      'CONSOLE_OUTBOX_NOT_FOUND' | 'OUTBOX_RECORD_NOT_FOUND'
    >;
  };
}

/** The result shape the console reads from any operation client. */
export type ShipConsoleCallResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly notModified?: boolean;
      readonly data?: unknown;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: { readonly code: string; readonly message: string };
    };

/**
 * The minimal client the console calls. Every `OperationClient<TContract>`
 * from `@sixthsummit/ship-angular/operations` satisfies it structurally, so
 * an application hands over the client it already provides.
 */
export interface ShipConsoleClient {
  call(operation: string, input: unknown): Promise<ShipConsoleCallResult>;
}
