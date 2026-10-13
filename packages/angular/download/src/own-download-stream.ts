import {
  OperationAbortedError,
  type OperationCallScope,
} from '@sixthsummit/ship-angular/operations';

/** Keep transport cancellation and timeout alive until the consumer finishes the body. */
export function ownDownloadStream(
  source: ReadableStream<Uint8Array>,
  scope: OperationCallScope,
  abortTransport: () => void,
  settle: (error?: unknown) => void
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let finished = false;
  let onAbort: () => void;
  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true;
    scope.signal.removeEventListener('abort', onAbort);
    // Capture the outcome before disposing timeout and parent signal listeners.
    settle(error);
    scope.cleanup();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        onAbort = () => {
          const error = scope.abortError() ?? new OperationAbortedError();
          finish(error);
          controller.error(error);
          void reader.cancel(error).catch(() => undefined);
        };
        scope.signal.addEventListener('abort', onAbort, { once: true });
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (finished) return;
          scope.throwIfAborted();
          if (next.done) {
            finish();
            controller.close();
            reader.releaseLock();
          } else controller.enqueue(next.value);
        } catch (error: unknown) {
          if (finished) return;
          finish(error);
          controller.error(error);
          void reader.cancel(error).catch(() => undefined);
        }
      },
      async cancel(reason) {
        scope.signal.removeEventListener('abort', onAbort);
        abortTransport();
        finish(new OperationAbortedError());
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}
