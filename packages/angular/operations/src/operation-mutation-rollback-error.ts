/** An operation outcome and its optimistic rollback both failed. */
export class OperationMutationRollbackError extends Error {
  readonly kind = 'mutation-rollback' as const;
  readonly operationError: Error;
  readonly rollbackError: Error;

  constructor(message: string, operationError: Error, rollbackError: Error) {
    super(message);
    this.name = 'OperationMutationRollbackError';
    this.operationError = operationError;
    this.rollbackError = rollbackError;
  }
}
