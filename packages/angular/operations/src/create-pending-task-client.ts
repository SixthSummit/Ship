import type { PendingTasks } from '@angular/core';
import type { OperationCallOptions, OperationClient } from './operation-client';
import type { HttpOperationId, InputOf } from './operation-contract';
import type { OperationResultOf } from './operation-result';

/** Hold one Angular pending task per call, across retries, released even when the call aborts. */
export function createPendingTaskClient<TContract extends object>(
  client: OperationClient<TContract>,
  pendingTasks: Pick<PendingTasks, 'add'>
): OperationClient<TContract> {
  return {
    call: async <TId extends HttpOperationId<TContract>>(
      operation: TId,
      input: InputOf<TContract, TId>,
      options?: OperationCallOptions
    ): Promise<OperationResultOf<TContract, TId>> => {
      const release = pendingTasks.add();
      try {
        return await client.call(operation, input, options);
      } finally {
        release();
      }
    },
  };
}
