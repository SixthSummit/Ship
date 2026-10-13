import type { OperationClient, OperationDefinition } from '@sixthsummit/ship-angular/operations';
import { type CreateQueryOptions, injectQuery } from '@tanstack/angular-query-experimental';
import type { ShipQueryKey } from '../keys/ship-query-key';
import { defineShipReadBinding } from '../keys/ship-read-binding';
import type { ShipQueryEnvelope } from '../read-executor/ship-query-envelope';
import { injectShipQuery } from './inject-ship-query';
import type { ShipQueryReadContext } from './ship-query-context';
import { shipQueryOptions } from './ship-query-options';

type Contract = {
  read: OperationDefinition<{ id: number }, { 200: { title: string } }, 'MISSING'>;
  stream: OperationDefinition<undefined, { 200: string }, never, 'stream'>;
};
declare const client: OperationClient<Contract>;
declare const context: ShipQueryReadContext;
const binding = defineShipReadBinding<Contract>()({
  operationId: 'read',
  safety: 'safe',
  inputKey: input => input.id,
  variantKey: null,
});
const options = shipQueryOptions(client, binding, { id: 1 }, context);
const compatible: CreateQueryOptions<
  ShipQueryEnvelope<Contract, 'read'>,
  Error,
  ShipQueryEnvelope<Contract, 'read'>,
  ShipQueryKey
> = options;
void compatible;
const selected = shipQueryOptions(client, binding, { id: 1 }, context, {
  select: envelope => envelope.data.title,
});
const selectedCompatible: CreateQueryOptions<
  ShipQueryEnvelope<Contract, 'read'>,
  Error,
  string,
  ShipQueryKey
> = selected;
void selectedCompatible;
// @ts-expect-error wrong operation input
shipQueryOptions(client, binding, { id: 'x' }, context);
// @ts-expect-error caller cannot override retry ownership
shipQueryOptions(client, binding, { id: 1 }, context, { retry: true });
// @ts-expect-error caller cannot override queryFn
shipQueryOptions(client, binding, { id: 1 }, context, { queryFn: () => null });
// @ts-expect-error caller cannot supply initialData from another scope
shipQueryOptions(client, binding, { id: 1 }, context, { initialData: {} });
// @ts-expect-error caller cannot supply placeholderData callbacks from another scope
shipQueryOptions(client, binding, { id: 1 }, context, { placeholderData: () => undefined });

const native = injectQuery(() => options);
const title: string | undefined = native.data()?.data.title;
void title;
const nativeSelected = injectQuery(() => selected);
const selectedTitle: string | undefined = nativeSelected.data();
void selectedTitle;

const scoped = injectShipQuery(client, binding, () => ({ id: 1 }), context);
const scopedTitle: string | undefined = scoped.data()?.data.title;
void scopedTitle;
const scopedSelected = injectShipQuery(client, binding, () => ({ id: 1 }), context, {
  select: envelope => envelope.data.title,
});
const scopedSelectedTitle: string | undefined = scopedSelected.data();
void scopedSelectedTitle;
// @ts-expect-error the scoped helper retains operation input types
injectShipQuery(client, binding, () => ({ id: 'wrong' }), context);
