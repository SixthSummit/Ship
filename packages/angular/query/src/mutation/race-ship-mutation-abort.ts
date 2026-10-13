import { OperationAbortedError } from '@sixthsummit/ship-angular/operations';

/** Stop waiting for a non-cooperative task while retaining rejection handling for its late outcome. */
export function raceShipMutationAbort<T>(
  run: () => T | PromiseLike<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new OperationAbortedError());
      return;
    }
    const abort = () => reject(new OperationAbortedError());
    signal.addEventListener('abort', abort, { once: true });
    try {
      Promise.resolve(run()).then(
        value => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) reject(new OperationAbortedError());
          else resolve(value);
        },
        error => {
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
    } catch (error: unknown) {
      signal.removeEventListener('abort', abort);
      reject(error);
    }
  });
}
