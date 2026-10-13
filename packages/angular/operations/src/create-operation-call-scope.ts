import { composeAbortSignals } from './compose-abort-signals';
import { OperationAbortedError } from './operation-aborted-error';
import { OperationTimeoutError } from './operation-timeout-error';

export interface OperationCallScope {
  readonly signal: AbortSignal;
  abortError(): OperationAbortedError | OperationTimeoutError | undefined;
  throwIfAborted(): void;
  cleanup(): void;
}

/** Compose call, resource/transport, SSR, and timeout cancellation without browser globals. */
export function createOperationCallScope(
  signals: readonly (AbortSignal | undefined)[],
  timeoutMs?: number
): OperationCallScope {
  const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
  const combined = composeAbortSignals([...signals, timeoutController?.signal]);
  let timedOut = false;
  const timeout =
    timeoutController === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
        }, timeoutMs);
  const abortError = (): OperationAbortedError | OperationTimeoutError | undefined => {
    if (!combined.signal.aborted) return undefined;
    return timedOut && timeoutMs !== undefined
      ? new OperationTimeoutError(timeoutMs)
      : new OperationAbortedError();
  };
  return {
    signal: combined.signal,
    abortError,
    throwIfAborted: () => {
      const error = abortError();
      if (error !== undefined) throw error;
    },
    cleanup: () => {
      if (timeout !== undefined) clearTimeout(timeout);
      combined.cleanup();
    },
  };
}
