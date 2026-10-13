import type { RemoteOperationId } from './operation-contract';

export type OperationSafety = 'safe' | 'idempotent' | 'unsafe';
export type OperationAuthentication = 'anonymous' | 'optional' | 'required';
export type OperationIdempotency = 'unsupported' | 'supported' | 'required';

export interface OperationRetryPolicy {
  /** Total attempts, including the first request. */
  readonly maxAttempts: number;
  readonly statuses: readonly number[];
}

/** Runtime policy projection emitted beside a client-safe operation contract. */
export interface OperationExecutionPolicy {
  readonly authentication: OperationAuthentication;
  readonly safety: OperationSafety;
  readonly idempotency: OperationIdempotency;
  /** Whether the serialized request body can be sent again byte-for-byte. */
  readonly replayable: boolean;
  readonly csrf?: boolean;
  /** Permit exactly one credential refresh after a 401, independently of backoff retry policy. */
  readonly refreshAuthentication?: boolean;
  readonly retry?: OperationRetryPolicy;
}

export type OperationPolicyMap<TContract extends object> = Readonly<{
  [TId in RemoteOperationId<TContract>]: OperationExecutionPolicy;
}>;
