import type { OperationClient, OperationDefinition } from '@sixthsummit/ship-angular/operations';
import { injectInfiniteQuery } from '@tanstack/angular-query-experimental';
import type { ShipQueryReadContext } from '../finite/ship-query-context';
import { defineShipReadBinding } from '../keys/ship-read-binding';
import { injectShipInfiniteQuery } from './inject-ship-infinite-query';
import { shipInfiniteQueryOptions } from './ship-infinite-query-options';
import type { ShipQueryPagination } from './ship-query-pagination';

type Contract = {
  read: OperationDefinition<
    { filter: string; cursor?: number },
    { 200: { title: string; next: number | null } },
    'DENIED'
  >;
};
declare const client: OperationClient<Contract>;
declare const context: ShipQueryReadContext;
const binding = defineShipReadBinding<Contract>()({
  operationId: 'read',
  safety: 'safe',
  inputKey: input => input.filter,
  variantKey: null,
});
const pagination: ShipQueryPagination<Contract, 'read', number> = {
  initialPageParam: 0,
  getNextPageParam: page => page.data.next,
  buildInput: (input, cursor) => ({ ...input, cursor }),
};
const options = shipInfiniteQueryOptions(client, binding, { filter: 'all' }, context, pagination);
const native = injectInfiniteQuery(() => options);
const title: string | undefined = native.data()?.pages[0]?.data.title;
void title;
const typed = injectShipInfiniteQuery(
  client,
  binding,
  () => ({ filter: 'all' }),
  context,
  pagination
);
const cursor: number | undefined = typed.data()?.pageParams[0];
void cursor;
const selected = injectShipInfiniteQuery(
  client,
  binding,
  () => ({ filter: 'all' }),
  context,
  pagination,
  { select: data => data.pages.length }
);
const count: number | undefined = selected.data();
void count;
// @ts-expect-error base input remains typed by the operation
shipInfiniteQueryOptions(client, binding, { filter: 1 }, context, pagination);
const invalid: ShipQueryPagination<Contract, 'read', number> = {
  ...pagination,
  // @ts-expect-error cursor callbacks cannot produce a different parameter type
  getNextPageParam: () => 'wrong',
};
void invalid;
// @ts-expect-error required initialPageParam cannot be omitted
shipInfiniteQueryOptions(client, binding, { filter: 'all' }, context, {
  getNextPageParam: pagination.getNextPageParam,
  buildInput: pagination.buildInput,
});
// @ts-expect-error undefined is not a supported key cursor
const noCursor: ShipQueryPagination<Contract, 'read', undefined> = pagination;
void noCursor;
// @ts-expect-error callers cannot change retry ownership
shipInfiniteQueryOptions(client, binding, { filter: 'all' }, context, pagination, { retry: true });
shipInfiniteQueryOptions(client, binding, { filter: 'all' }, context, pagination, {
  // @ts-expect-error callers cannot replace the pagination function
  getNextPageParam: () => 1,
});
// @ts-expect-error guarded page controls cannot enable duplicate requests
typed.fetchNextPage({ cancelRefetch: true });

if (typed.isSuccess()) {
  const ready = typed.data();
  void ready;
}
