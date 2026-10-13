/** Compose abort scopes and provide explicit listener cleanup for long-lived resources. */
export function composeAbortSignals(sources: readonly (AbortSignal | undefined)[]): {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  for (const source of sources) {
    if (source === undefined) continue;
    if (source.aborted) {
      controller.abort();
      break;
    }
    const listener = () => controller.abort();
    source.addEventListener('abort', listener, { once: true });
    listeners.push([source, listener]);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
    },
  };
}
