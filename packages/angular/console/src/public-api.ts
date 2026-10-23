/** @packageDocumentation Operator console panels over the `@sixthsummit/ship-console` operations. */
export { ShipConsoleAppComponent } from './console-app.component';
export type {
  ConsoleFrameworkErrorCode,
  ConsoleOperation,
  ShipConsoleCallResult,
  ShipConsoleClient,
  ShipConsoleContract,
} from './console-contract';
export { formatInstant, formatJson, formatTrigger } from './console-format';
export { ShipConsoleShellComponent } from './console-shell.component';
export type {
  ConsoleAttemptFailure,
  ConsoleChannel,
  ConsoleDispatch,
  ConsoleFailure,
  ConsoleJobCapabilities,
  ConsoleJobEntry,
  ConsoleJobsOverview,
  ConsoleObservedReceipt,
  ConsoleOutboxEntry,
  ConsoleOutboxes,
  ConsoleOutboxRecord,
  ConsoleOutboxRecordStatus,
  ConsoleOutboxRecords,
  ConsolePanelDescriptor,
  ConsolePanels,
  ConsoleRealtime,
  ConsoleReceipt,
  ConsoleReceiptDetail,
  ConsoleReceiptQuery,
  ConsoleReceipts,
  ConsoleReplayed,
  ConsoleRun,
  ConsoleRunQuery,
  ConsoleRunStatus,
  ConsoleSchedule,
  ConsoleTrigger,
  ConsoleTriggered,
  ConsoleWebhookEndpoint,
} from './console-views';
export { ShipConsoleCronPanelComponent } from './cron-panel.component';
export { ShipConsoleJobsPanelComponent } from './jobs-panel.component';
export { ShipConsoleOutboxPanelComponent } from './outbox-panel.component';
export { injectConsole, provideShipConsole, SHIP_CONSOLE } from './provide-ship-console';
export { ShipConsoleRealtimePanelComponent } from './realtime-panel.component';
export { DEFAULT_CONSOLE_PREFIX, ShipConsole, type ShipConsoleOptions } from './ship-console';
export { type ShipConsoleRoutesOptions, shipConsoleRoutes } from './ship-console.routes';
export { ShipConsoleWebhooksPanelComponent } from './webhooks-panel.component';
