import type { HttpOperationId, InputOf } from './operation-contract';
import type { OperationResultOf } from './operation-result';

/** Per-call controls understood by a structural operation client. */
export interface OperationCallOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
  /**
   * Ask the transport to keep the request alive after its page unloads (fetch `keepalive`).
   *
   * Opt in only for final heartbeat/complete calls issued from `pagehide` or a hidden tab.
   * Browsers cap keepalive request bodies at 64 KiB; the client does not enforce that limit.
   * Every retry attempt of a keepalive call keeps the flag. Default: not set.
   */
  readonly keepalive?: boolean;
}

/** Internal transport controls prepared by the shared policy pipeline. */
export interface OperationExecutionOptions extends OperationCallOptions {
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly credentials?: RequestCredentials;
}

/**
 * Framework-independent operation invocation seam.
 *
 * ShipAngular owns Angular integration around this interface. URL construction,
 * serialization, response decoding, and generated operation metadata remain owned by
 * the ShipAPI client artifact (or an explicit compatibility adapter).
 */
export interface OperationClient<TContract extends object> {
  call<TId extends HttpOperationId<TContract>>(
    operation: TId,
    input: InputOf<TContract, TId>,
    options?: OperationCallOptions
  ): Promise<OperationResultOf<TContract, TId>>;
}

/** Structural executor implemented by a generated HTTP client or compatibility adapter. */
export interface OperationExecutor<TContract extends object> {
  call<TId extends HttpOperationId<TContract>>(
    operation: TId,
    input: InputOf<TContract, TId>,
    options: OperationExecutionOptions
  ): Promise<OperationResultOf<TContract, TId>>;
}
