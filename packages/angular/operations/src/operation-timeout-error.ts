/** A call exceeded its configured client-side deadline. */
export class OperationTimeoutError extends Error {
  readonly kind = 'timeout' as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
