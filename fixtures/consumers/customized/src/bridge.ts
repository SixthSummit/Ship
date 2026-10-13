import {
  type AnyModule,
  type ApplicationExecutor,
  type ChannelPublisherRegistry,
  type CompiledApplication,
  createChannelPublisherRegistry,
  createExecutor,
  type InferSchemaInput,
  type OperationActor,
  type OperationExecutionFailure,
  type OperationExecutionResult,
  type OperationId,
  type OperationRawInput,
  type OutboxDispatchRunner,
  type OutboxDispatchRunnerOptions,
  type RealtimePublicationRunner,
  type RealtimePublicationRunnerOptions,
  type RealtimePublishBackend,
  startOutboxDispatchRunner,
  startRealtimePublicationRunner,
} from "@sixthsummit/ship-core";
import { notificationDelivered } from "./channels.js";

/**
 * The seam a legacy, non-kernel call site (a console controller, a cron
 * script) uses while it migrates. Nothing here names a channel-to-token map:
 * publishers are derived from the compiled application's own channel
 * declarations, every publish is validated by the channel schema at runtime,
 * unexpected execution errors come back as the 500 envelope instead of a
 * throw, and the publication dispatcher runs without the jobs capability.
 */
export interface LegacyBridge<TApp extends CompiledApplication<string, readonly AnyModule[]>> {
  readonly executor: ApplicationExecutor<TApp>;
  readonly publishers: ChannelPublisherRegistry;
  /** Publishes to any declared channel by id; scope and payload are validated by the channel. */
  publish(channelId: string, scopeKey: string, payload: unknown): Promise<void>;
  /** Narrowed to the channel's declared payload type for call sites that know the channel. */
  notifyDelivered(
    actorId: string,
    payload: InferSchemaInput<typeof notificationDelivered.payload>,
  ): Promise<void>;
  /** Every call answers with a result; framework and infrastructure faults become the 500 envelope. */
  call<TId extends OperationId<TApp>>(
    operationId: TId,
    input: OperationRawInput<TApp["operationById"][TId]>,
    actor: OperationActor,
  ): Promise<OperationExecutionResult<TApp["operationById"][TId]> | OperationExecutionFailure>;
  /** Starts the framework dispatcher loop for durable publications in this process. */
  startDispatcher(options?: RealtimePublicationRunnerOptions): RealtimePublicationRunner;
  /**
   * Starts the framework's adaptive dispatch loop for `reports.outbox` in this
   * process: a full batch is followed by the next pass at once, a short or
   * empty pass waits the interval.
   */
  startReportsDispatcher(options?: OutboxDispatchRunnerOptions): OutboxDispatchRunner;
}

export function createLegacyBridge<TApp extends CompiledApplication<string, readonly AnyModule[]>>(
  application: TApp,
  realtime: RealtimePublishBackend,
): LegacyBridge<TApp> {
  const executor: ApplicationExecutor<TApp> = createExecutor(application);
  const publishers = createChannelPublisherRegistry(application, realtime);
  const bridge: LegacyBridge<TApp> = {
    executor,
    publishers,
    publish: (channelId: string, scopeKey: string, payload: unknown) =>
      publishers.publish(channelId, scopeKey, payload),
    notifyDelivered: (
      actorId: string,
      payload: InferSchemaInput<typeof notificationDelivered.payload>,
    ) => publishers.for(notificationDelivered).publish(actorId, payload),
    call: (operationId, input, actor: OperationActor) =>
      executor.tryRun(operationId, input, { actor }),
    startDispatcher: (options: RealtimePublicationRunnerOptions = {}) =>
      startRealtimePublicationRunner(executor, options),
    startReportsDispatcher: (options: OutboxDispatchRunnerOptions = {}) =>
      startOutboxDispatchRunner(executor, "reports.outbox.dispatch", options),
  };
  return Object.freeze(bridge);
}
