import type { HttpOperationId, InputOf } from '@sixthsummit/ship-angular/operations';
import type { CreateMutationOptions } from '@tanstack/angular-query-experimental';
import type { ShipMutationEnvelope } from './ship-mutation-envelope';

/** Construct once. Reading the factory tracks identity without replacing its mutation executor. */
export interface ShipMutationOptionsFactory<C extends object, I extends HttpOperationId<C>> {
  (): CreateMutationOptions<ShipMutationEnvelope<C, I>, Error, InputOf<C, I>, undefined>;
  cancel(): boolean;
  /** The factory owner calls this at teardown. Views only detach their own observers.
   * Active executions also register scope cancellation and remove that registration on settlement.
   * Current-scope optimism is rolled back before destruction resolves.
   */
  destroy(): Promise<void>;
}
