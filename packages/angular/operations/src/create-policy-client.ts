import { createOperationCallScope } from './create-operation-call-scope';
import {
  createOperationRequestPolicy,
  type OperationRequestPolicy,
  type OperationRequestPolicyConfig,
} from './create-operation-request-policy';
import type { OperationCallOptions, OperationClient, OperationExecutor } from './operation-client';
import type { HttpOperationId, InputOf } from './operation-contract';
import type { OperationResultOf } from './operation-result';
import {
  abortableOperationDelay,
  type OperationRetryTiming,
  operationRetryDelay,
  shouldRetryOperationResponse,
} from './operation-retry';

export interface OperationPolicyClientConfig<TContract extends object>
  extends OperationRequestPolicyConfig<TContract> {
  readonly signal?: AbortSignal;
  /** Absolute API base used by the shared origin allowlist for unary calls. */
  readonly targetUrl?: string;
  readonly retry?: OperationRetryTiming;
  /** Deterministic test hook. Production callers should use the default abortable timer. */
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type OperationPolicyClientRuntimeOptions = Pick<
  OperationPolicyClientConfig<object>,
  'signal' | 'targetUrl' | 'retry' | 'delay'
>;

/** Wrap a generated executor with the one shared operation request-policy pipeline. */
export function createPolicyClient<TContract extends object>(
  executor: OperationExecutor<TContract>,
  config: OperationPolicyClientConfig<TContract>
): OperationClient<TContract> {
  return createPolicyClientFromPolicy(executor, createOperationRequestPolicy(config), config);
}

/** Use one already-created request policy across unary and non-JSON operation transports. */
export function createPolicyClientFromPolicy<TContract extends object>(
  executor: OperationExecutor<TContract>,
  requestPolicy: OperationRequestPolicy<TContract>,
  runtime: OperationPolicyClientRuntimeOptions = {}
): OperationClient<TContract> {
  return {
    call: <TId extends HttpOperationId<TContract>>(
      operation: TId,
      input: InputOf<TContract, TId>,
      callOptions: OperationCallOptions = {}
    ): Promise<OperationResultOf<TContract, TId>> =>
      executeWithPolicy(executor, requestPolicy, runtime, operation, input, callOptions),
  };
}

async function executeWithPolicy<TContract extends object, TId extends HttpOperationId<TContract>>(
  executor: OperationExecutor<TContract>,
  requestPolicy: OperationRequestPolicy<TContract>,
  config: OperationPolicyClientRuntimeOptions,
  operation: TId,
  input: InputOf<TContract, TId>,
  options: OperationCallOptions
): Promise<OperationResultOf<TContract, TId>> {
  const policyCall = requestPolicy.begin(operation, options);
  const scope = createOperationCallScope([options.signal, config.signal], options.timeoutMs);
  try {
    scope.throwIfAborted();
    let attempt = 1;
    let retryAttempt = 1;
    while (true) {
      try {
        const prepared = await policyCall.prepare({
          attempt,
          signal: scope.signal,
          ...(config.targetUrl === undefined ? {} : { targetUrl: config.targetUrl }),
        });
        scope.throwIfAborted();
        const result = await executor.call(operation, input, prepared);
        if (await policyCall.refreshAuthentication(result.status, attempt, scope.signal)) {
          attempt += 1;
          continue;
        }
        if (
          !shouldRetryOperationResponse(
            result,
            policyCall.executionPolicy,
            options.idempotencyKey,
            retryAttempt
          )
        ) {
          return result;
        }
        const delayMs = operationRetryDelay(
          result.headers.retryAfterMs,
          retryAttempt,
          config.retry
        );
        await (config.delay ?? abortableOperationDelay)(delayMs, scope.signal);
        retryAttempt += 1;
        attempt += 1;
      } catch (error: unknown) {
        const abortError = scope.abortError();
        if (abortError !== undefined) throw abortError;
        throw error;
      }
    }
  } finally {
    scope.cleanup();
  }
}
