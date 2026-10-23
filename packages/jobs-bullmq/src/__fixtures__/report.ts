/**
 * Logs a connection-level error to stderr instead of letting it escape as an
 * unhandled 'error' event. The fixtures are test processes, so the log line is
 * the diagnostic; the process keeps running and the clients reconnect.
 */
export function reportConnectionError(source: string) {
  return (client: string) => (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${source}] ${client}: ${message}\n`);
  };
}
