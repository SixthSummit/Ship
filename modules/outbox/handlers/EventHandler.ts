import type { OutboxEvent } from "../schema.js";

/**
 * Consumer-side event handler contract.
 *
 * One handler maps to one event type. The drain worker dispatches each
 * pending row to the matching handler; the handler does the actual
 * publish (queue enqueue, webhook POST, log emit, …) and returns
 * normally on success or throws on failure. Handler throws are
 * captured by the drainer and translated to retry / mark-failed
 * decisions based on the row's retry budget.
 *
 * Handlers MUST be idempotent. The outbox guarantees at-least-once
 * delivery — a handler may be re-invoked for the same event after a
 * crash, after stale-processing recovery, or after an exhausted
 * retry budget gets re-enabled by an admin. Use `dedupeKey` /
 * `eventId` for downstream deduplication where the consumer system
 * supports it.
 *
 * Handlers SHOULD honor `ctx.signal` for graceful shutdown — when
 * the worker is asked to stop mid-publish, the signal aborts and
 * the handler should clean up rather than push past.
 */
export interface EventHandler<TPayload = Record<string, unknown>> {
  /** Stable event type matching `OutboxEvent.eventType`. */
  readonly eventType: string;
  /**
   * Schema version this handler supports. When omitted, the handler
   * accepts any version (caller-side responsibility to keep handlers
   * forward-compatible). When set, the drainer skips events with a
   * different version (or routes to a versioned alternative if
   * registered).
   */
  readonly eventVersion?: number;
  /** Run the handler. Throw to signal failure (drainer decides retry vs final-fail). */
  handle(event: OutboxEvent & { payload: TPayload }, ctx: HandlerContext): Promise<void>;
}

export interface HandlerContext {
  /** Aborts when the drain worker is stopping. Handlers honor this. */
  signal?: AbortSignal;
  /** Per-attempt scoped logger / metadata. Caller decides shape. */
  metadata?: Record<string, unknown>;
}

/**
 * Registry of `EventHandler`s keyed by `eventType` (+ optional
 * `eventVersion` discriminator). The drainer does
 * `registry.findHandler(event)` to dispatch each row.
 *
 * Replaces v3's `EventHandlerRegistry` static-class pattern with an
 * instance-based registry. Same justification as `OAuthAdapterRegistry`:
 * lets consumers compose handler sets per app / per tenant without
 * touching framework globals.
 */
export class EventHandlerRegistry {
  // Two-level map: eventType → (versionKey → handler). versionKey is
  // either the literal version number or the sentinel "*" for
  // version-agnostic handlers.
  private readonly handlers = new Map<string, Map<string, EventHandler>>();

  register(handler: EventHandler): this {
    const versionKey = handler.eventVersion === undefined ? "*" : String(handler.eventVersion);
    let versions = this.handlers.get(handler.eventType);
    if (!versions) {
      versions = new Map();
      this.handlers.set(handler.eventType, versions);
    }
    if (versions.has(versionKey)) {
      throw new Error(
        `EventHandlerRegistry: duplicate handler for ${handler.eventType} v${versionKey}`,
      );
    }
    versions.set(versionKey, handler);
    return this;
  }

  /**
   * Find the handler for an event. Resolution order:
   *   1. Exact `(eventType, eventVersion)` match
   *   2. Version-agnostic `(eventType, *)` fallback
   * Returns `undefined` when nothing is registered for the event type.
   */
  findHandler(
    event: Pick<{ eventType: string; eventVersion: number }, "eventType" | "eventVersion">,
  ): EventHandler | undefined {
    const versions = this.handlers.get(event.eventType);
    if (!versions) return undefined;
    const exact = versions.get(String(event.eventVersion));
    if (exact) return exact;
    return versions.get("*");
  }

  /** Adapter-equivalent of `has` — true when *any* handler matches. */
  hasHandler(eventType: string): boolean {
    return this.handlers.has(eventType);
  }

  /** All event types with at least one registered handler. */
  eventTypes(): string[] {
    return [...this.handlers.keys()];
  }

  size(): number {
    let total = 0;
    for (const versions of this.handlers.values()) total += versions.size;
    return total;
  }
}

export function eventHandlerRegistry(...handlers: EventHandler[]): EventHandlerRegistry {
  const registry = new EventHandlerRegistry();
  for (const h of handlers) registry.register(h);
  return registry;
}
