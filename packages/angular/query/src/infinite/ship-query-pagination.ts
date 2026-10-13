import type { HttpOperationId, InputOf } from '@sixthsummit/ship-angular/operations';
import type {
  GetNextPageParamFunction,
  GetPreviousPageParamFunction,
} from '@tanstack/angular-query-experimental';
import type { ShipQueryKeyValue } from '../keys/ship-query-key';
import type { ShipQueryEnvelope } from '../read-executor/ship-query-envelope';

/** V1 page parameters are JSON key values. Use null for an empty initial cursor. */
export interface ShipQueryPagination<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TPageParam extends ShipQueryKeyValue,
> {
  readonly initialPageParam: TPageParam;
  readonly getNextPageParam: GetNextPageParamFunction<
    TPageParam,
    ShipQueryEnvelope<TContract, TId>
  >;
  readonly getPreviousPageParam?: GetPreviousPageParamFunction<
    TPageParam,
    ShipQueryEnvelope<TContract, TId>
  >;
  readonly buildInput: (
    input: InputOf<TContract, TId>,
    pageParam: TPageParam
  ) => InputOf<TContract, TId>;
}
