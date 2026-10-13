/** A caller, resource, component, or SSR request canceled an operation. */
export class OperationAbortedError extends Error {
  readonly kind = 'aborted' as const;

  constructor(message = 'Operation was aborted') {
    super(message);
    this.name = 'OperationAbortedError';
  }
}
