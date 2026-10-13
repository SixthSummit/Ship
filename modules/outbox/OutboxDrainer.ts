import type { EventHandlerRegistry } from "./handlers/EventHandler.js";
import { hasExhaustedRetries, type OutboxEvent } from "./schema.js";
import type { OutboxEventService } from "./services/OutboxEventService.js";

/**
 * Consumer-side drain orchestrator. One pass:
 *
 *   1. `findReadyToPublish(batchSize)` — pull pending rows
 *   2. `claimForProcessing(ids)` — atomic pending→processing
 *      transition (concurrent-safe — competing workers see different
 *      claimed subsets)
 *   3. For each claimed row:
 *      - Resolve the handler via the registry
 *      - Invoke `handler.handle(event, ctx)`
 *      - On success → `markPublished(id)`
 *      - On throw → check the retry budget:
 *          - If exhausted → `markFailed(id, error)` (terminal)
 *          - Otherwise → `markForRetry(id, error, attempts)` (revert to pending,
 *            schedule via exponential backoff)
 *      - If no handler matches → mark for retry with a "no handler"
 *        message; ops backfills the handler and the next drain
 *        retries automatically.
 *   4. Returns a summary — published / failed / retried counts.
 *
 * `runOnce()` does one pass. `runUntilEmpty()` keeps passing until
 * the database returns 0 ready rows (polling-friendly worker entry
 * point — wraps with `setInterval` outside this class).
 *
 * Honors `signal` end-to-end: handler invocations receive the same
 * AbortSignal, the loop exits between batches, and the loop also
 * exits *between* per-event handler calls so a SIGTERM mid-batch
 * doesn't have to wait for the entire batch to finish.
 */

export interface OutboxDrainerOptions {
  /**
   * Rows to claim per drain pass. Larger = fewer round trips but
   * longer per-pass latency. Default 50.
   */
  batchSize?: number;
  /** AbortSignal to short-circuit between handler invocations. */
  signal?: AbortSignal;
  /**
   * Per-handler context the registry forwards to each handler.
   * Typical contents: `{ requestId, traceId }`.
   */
  metadata?: Record<string, unknown>;
}

export interface OutboxDrainerResult {
  /** Total events processed in this pass. */
  processed: number;
  /** Successfully published — terminal success. */
  published: number;
  /** Permanently failed — exhausted retry budget. */
  failed: number;
  /** Scheduled for retry — non-terminal failure. */
  retried: number;
  /** Skipped because no handler is registered for the event type. */
  skippedNoHandler: number;
}

const ZERO_RESULT: OutboxDrainerResult = {
  processed: 0,
  published: 0,
  failed: 0,
  retried: 0,
  skippedNoHandler: 0,
};

export class OutboxDrainer {
  constructor(
    private readonly service: OutboxEventService,
    private readonly handlers: EventHandlerRegistry,
  ) {}

  async runOnce(opts: OutboxDrainerOptions = {}): Promise<OutboxDrainerResult> {
    const batchSize = opts.batchSize ?? 50;
    if (opts.signal?.aborted) return { ...ZERO_RESULT };

    const candidates = await this.service.findReadyToPublish(batchSize);
    if (candidates.length === 0) return { ...ZERO_RESULT };

    const claimedIds = await this.service.claimForProcessing(candidates.map((c) => c.id));
    const claimed = candidates.filter((c) => claimedIds.includes(c.id));

    const result: OutboxDrainerResult = { ...ZERO_RESULT };
    result.processed = claimed.length;

    for (const event of claimed) {
      if (opts.signal?.aborted) break;
      await this.processOne(event, opts, result);
    }

    return result;
  }

  /**
   * Loop `runOnce` until a pass returns `processed: 0` (queue
   * drained) or the signal aborts. Useful for cron-driven flushes
   * and for catch-up runs after an outage.
   */
  async runUntilEmpty(opts: OutboxDrainerOptions = {}): Promise<OutboxDrainerResult> {
    const total: OutboxDrainerResult = { ...ZERO_RESULT };
    while (!opts.signal?.aborted) {
      const pass = await this.runOnce(opts);
      total.processed += pass.processed;
      total.published += pass.published;
      total.failed += pass.failed;
      total.retried += pass.retried;
      total.skippedNoHandler += pass.skippedNoHandler;
      if (pass.processed === 0) break;
    }
    return total;
  }

  private async processOne(
    event: OutboxEvent,
    opts: OutboxDrainerOptions,
    result: OutboxDrainerResult,
  ): Promise<void> {
    const handler = this.handlers.findHandler({
      eventType: event.eventType,
      eventVersion: event.eventVersion,
    });

    if (!handler) {
      // No handler registered. Don't fail-permanent — ops may add
      // the handler later and the next drain should retry. Mark
      // for retry with a clear marker, but don't increment the
      // attempt charge against the row (claimForProcessing already
      // bumped it).
      const message = `no handler registered for ${event.eventType} (v${event.eventVersion})`;
      if (hasExhaustedRetries(event)) {
        await this.service.markFailed(event.id, message);
        result.failed += 1;
      } else {
        await this.service.markForRetry(event.id, message, event.publishAttempts);
        result.retried += 1;
      }
      result.skippedNoHandler += 1;
      return;
    }

    try {
      await handler.handle(event as never, {
        signal: opts.signal,
        metadata: opts.metadata,
      });
      await this.service.markPublished(event.id);
      result.published += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (hasExhaustedRetries(event)) {
        await this.service.markFailed(event.id, message);
        result.failed += 1;
      } else {
        await this.service.markForRetry(event.id, message, event.publishAttempts);
        result.retried += 1;
      }
    }
  }
}
