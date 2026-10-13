import type { ShipQueryScopeSnapshot } from './ship-query-scope-snapshot';

/** Identity lifecycle shared by queries, mutation effects, and application listeners. */
export interface ShipQueryScopeController {
  /** Signal-tracked identity, including during a transition. Throws after destruction. */
  capture(): ShipQueryScopeSnapshot;
  /** Signal-tracked readiness. False during transitions and after destruction. */
  isCurrent(snapshot: ShipQueryScopeSnapshot): boolean;
  /** Stale or not-yet-ready snapshots receive an already-aborted signal. */
  signal(snapshot: ShipQueryScopeSnapshot): AbortSignal;
  /** Invalidate the old generation immediately; await cancellation before enabling the new one. */
  change(nextIdentity: string): Promise<ShipQueryScopeSnapshot>;
  /** Stop a listener when its captured generation ends. Stale registrations run immediately. */
  onCleanup(snapshot: ShipQueryScopeSnapshot, cleanup: () => void): () => void;
  /** Cancel owned mutation work, without resetting an executor that is still active. */
  registerMutation(snapshot: ShipQueryScopeSnapshot, cancel: () => void): () => void;
  /** Guard a synchronous cache effect. After each await, call this again at the actual write. */
  runIfCurrent(snapshot: ShipQueryScopeSnapshot, effect: () => void): boolean;
  destroy(): Promise<void>;
}
