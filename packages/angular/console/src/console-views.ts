/** Wire shapes of the `@sixthsummit/ship-console` operations, as the Angular panels read them. */

export interface ConsolePanelDescriptor {
  readonly id: string;
  readonly title: string;
  readonly operations: readonly string[];
}

export interface ConsolePanels {
  readonly id: string;
  readonly basePath: string;
  readonly permission: string;
  readonly panels: readonly ConsolePanelDescriptor[];
}

export interface ConsoleTrigger {
  readonly kind: 'schedule' | 'interval' | 'enqueue' | 'http';
  readonly cron?: string;
  readonly tz?: string;
  readonly everyMs?: number;
}

export interface ConsoleJobCapabilities {
  readonly adapter: string;
  readonly runs: boolean;
  readonly schedules: boolean;
  readonly pause: boolean;
}

export interface ConsoleJobEntry {
  readonly jobId: string;
  readonly declared: boolean;
  readonly trigger?: ConsoleTrigger;
  readonly concurrency?: { readonly mode: string; readonly max: number };
  readonly retryAttempts?: number;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly lagMs: number;
  readonly lastRunAt?: string;
  readonly lastSuccessAt?: string;
  readonly paused: boolean;
}

export interface ConsoleJobsOverview {
  readonly capabilities: ConsoleJobCapabilities;
  readonly jobs: readonly ConsoleJobEntry[];
}

export type ConsoleRunStatus =
  | 'waiting'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed'
  | 'discarded';

export interface ConsoleAttemptFailure {
  readonly attempt: number;
  readonly error: string;
  readonly at: string;
}

export interface ConsoleRun {
  readonly runId: string;
  readonly jobId: string;
  readonly input?: unknown;
  readonly status: string;
  readonly attempts: number;
  readonly history: readonly ConsoleAttemptFailure[];
  readonly createdAt: string;
  readonly availableAt: string;
  readonly key?: string;
  readonly dedupeKey?: string;
  readonly lastError?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly discardedAt?: string;
  readonly discardReason?: string;
}

export interface ConsoleRunQuery {
  readonly jobId?: string;
  readonly status?: ConsoleRunStatus;
  readonly limit?: number;
}

export interface ConsoleSchedule {
  readonly jobId: string;
  readonly trigger: ConsoleTrigger;
  readonly nextAt?: string;
  readonly lastRunAt?: string;
  readonly lastSuccessAt?: string;
  readonly paused: boolean;
  readonly reconciled: boolean;
}

export interface ConsoleTriggered {
  readonly jobId: string;
  readonly runId: string;
  readonly deduplicated: boolean;
}

export interface ConsoleWebhookEndpoint {
  readonly id: string;
  readonly provider: string;
  readonly path: string;
  readonly mode: 'inline' | 'enqueue';
  readonly outboxId?: string;
  readonly intent?: string;
}

export interface ConsoleObservedReceipt {
  readonly webhookId: string;
  readonly provider: string;
  readonly outcome: string;
  readonly status: number;
  readonly reason?: string;
  readonly durationMs: number;
  readonly at: string;
}

export interface ConsoleDispatch {
  readonly recordId: string;
  readonly outboxId: string;
  readonly intentId: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError?: string;
  readonly availableAt: string;
  readonly completedAt?: string;
  readonly deadLetteredAt?: string;
}

export interface ConsoleReceipt {
  readonly eventId: string;
  readonly webhookId: string;
  readonly provider: string;
  readonly providerEventId?: string;
  readonly requestId: string;
  readonly receivedAt: string;
  readonly contentType?: string;
  readonly bytes: number;
  readonly verification: 'verified';
  readonly outboxRecordId?: string;
  readonly dispatch?: ConsoleDispatch;
}

export interface ConsoleReceiptDetail extends ConsoleReceipt {
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText?: string;
}

export interface ConsoleReceipts {
  readonly webhooks: readonly ConsoleWebhookEndpoint[];
  readonly capabilities: {
    readonly list: boolean;
    readonly dispatch: boolean;
    readonly observed: boolean;
  };
  readonly receipts: readonly ConsoleReceipt[];
  readonly observed: readonly ConsoleObservedReceipt[];
}

export interface ConsoleReceiptQuery {
  readonly webhookId?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface ConsoleReplayed {
  readonly eventId: string;
  readonly webhookId: string;
  readonly queued: boolean;
}

export interface ConsoleChannel {
  readonly channelId: string;
  readonly scope: 'actor' | 'tenant' | 'resource';
  readonly presence: boolean;
  readonly subscribers?: number;
  readonly scopes?: number;
  readonly lastPublishedAt?: string;
  readonly lastScopeKey?: string;
}

export interface ConsoleRealtime {
  readonly backend: {
    readonly id: string;
    readonly adapter: string;
    readonly ok: boolean;
    readonly detail?: string;
  };
  readonly capabilities: { readonly introspection: boolean };
  readonly channels: readonly ConsoleChannel[];
}

export interface ConsoleOutboxEntry {
  readonly outboxId: string;
  readonly intents: readonly string[];
  readonly adapter?: string;
  readonly pending: number;
  readonly claimed: number;
  readonly deadLettered: number;
  readonly oldestPendingAt?: string;
  readonly capabilities: { readonly records: boolean };
}

export interface ConsoleOutboxes {
  readonly outboxes: readonly ConsoleOutboxEntry[];
}

export type ConsoleOutboxRecordStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'dead-lettered'
  | 'discarded';

export interface ConsoleOutboxRecord {
  readonly id: string;
  readonly intentId: string;
  readonly payload?: unknown;
  readonly status: string;
  readonly attempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly dedupeKey?: string;
  readonly lastError?: string;
  readonly leaseExpiresAt?: string;
  readonly completedAt?: string;
  readonly deadLetteredAt?: string;
  readonly discardedAt?: string;
  readonly discardReason?: string;
}

export interface ConsoleOutboxRecords {
  readonly outboxId: string;
  readonly records: readonly ConsoleOutboxRecord[];
}

/** The last failed console call, kept as a value so a panel can show it inline. */
export interface ConsoleFailure {
  readonly operation: string;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}
