import type { Signal } from '@angular/core';
import type {
  HttpOperationId,
  InputOf,
  OperationClient,
  OperationDataOf,
  OperationSuccessOf,
} from '@sixthsummit/ship-angular/operations';
import type {
  CreateQueryOptions,
  CreateQueryResult,
  QueryClient,
} from '@tanstack/angular-query-experimental';

export type ShipQueryKeyValue =
  | null
  | string
  | number
  | boolean
  | readonly ShipQueryKeyValue[]
  | { readonly [key: string]: ShipQueryKeyValue };
export interface ShipQueryContext {
  readonly queryClient: QueryClient;
  readonly scope: { capture(): { namespace: string; scopeKey: string; generation: number } };
}
export interface ShipQueryEnvelope<C extends object, I extends HttpOperationId<C>> {
  readonly data: OperationDataOf<C, I>;
  readonly result: OperationSuccessOf<C, I>;
  readonly etag?: string;
}
export interface ShipReadBinding<C extends object, I extends HttpOperationId<C>> {
  readonly operationId: I;
  readonly safety: 'safe';
  readonly inputKey: (input: InputOf<C, I>) => ShipQueryKeyValue;
  readonly variantKey: ShipQueryKeyValue;
}
export declare function defineShipReadBinding<C extends object>(): <I extends HttpOperationId<C>>(
  binding: ShipReadBinding<C, I>
) => ShipReadBinding<C, I>;
export type ShipQueryOptions<
  C extends object,
  I extends HttpOperationId<C>,
  S = ShipQueryEnvelope<C, I>,
> = Pick<
  CreateQueryOptions<ShipQueryEnvelope<C, I>, Error, S>,
  | 'select'
  | 'staleTime'
  | 'gcTime'
  | 'refetchOnMount'
  | 'refetchOnWindowFocus'
  | 'refetchOnReconnect'
>;
export declare function injectShipQuery<
  C extends object,
  I extends HttpOperationId<C>,
  S = ShipQueryEnvelope<C, I>,
>(
  client: OperationClient<C>,
  binding: ShipReadBinding<C, I>,
  input: () => InputOf<C, I> | undefined,
  context: ShipQueryContext,
  options?: ShipQueryOptions<C, I, S> | (() => ShipQueryOptions<C, I, S>)
): CreateQueryResult<S, Error>;
export interface FixtureReactiveInput<T> {
  readonly value: Signal<T | undefined>;
}
