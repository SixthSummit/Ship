import { OperationAbortedError } from './operation-aborted-error';
import type { OperationExecutionPolicy } from './operation-policy';

export interface OperationRetryTiming {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** Apply the same explicit, conservative retry eligibility rules to every transport. */
export function shouldRetryOperationResponse(
  result: { readonly ok: boolean; readonly status: number },
  policy: OperationExecutionPolicy,
  idempotencyKey: string | undefined,
  retryAttempt: number
): boolean {
  const retry = policy.retry;
  if (result.ok || retry === undefined || retryAttempt >= retry.maxAttempts) return false;
  if (!retry.statuses.includes(result.status) || result.status === 401 || result.status === 403) {
    return false;
  }
  if (policy.safety === 'safe') return true;
  return (
    policy.replayable &&
    policy.idempotency !== 'unsupported' &&
    idempotencyKey !== undefined &&
    idempotencyKey.length > 0
  );
}

/** Prefer a valid server Retry-After delay, otherwise use capped exponential backoff. */
export function operationRetryDelay(
  serverDelayMs: number | undefined,
  retryAttempt: number,
  timing?: OperationRetryTiming
): number {
  if (serverDelayMs !== undefined) return serverDelayMs;
  const base = timing?.baseDelayMs ?? 250;
  const maximum = timing?.maxDelayMs ?? 30_000;
  return Math.min(maximum, base * 2 ** (retryAttempt - 1));
}

/** Wait for a retry without losing cancellation. */
export function abortableOperationDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new OperationAbortedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OperationAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
