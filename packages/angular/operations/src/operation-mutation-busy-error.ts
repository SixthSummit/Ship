/** A reject-concurrency mutation was invoked while its previous call was still pending. */
export class OperationMutationBusyError extends Error {
  readonly kind = 'mutation-busy' as const;

  constructor() {
    super('Operation mutation already has a pending call');
    this.name = 'OperationMutationBusyError';
  }
}
