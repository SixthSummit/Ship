import type { OperationClient, OperationDefinition } from '@sixthsummit/ship-angular/operations';
import {
  defineShipReadBinding,
  injectShipMutation,
  injectShipQuery,
  type ShipQueryContext,
  shipMutationOptions,
  shipQueryOptions,
} from '@sixthsummit/ship-angular/query';

type Contract = {
  read: OperationDefinition<{ id: string }, { 200: { title: string }; 204: undefined }, 'MISSING'>;
  write: OperationDefinition<{ title: string }, { 200: { title: string } }, 'CONFLICT'>;
  download: OperationDefinition<undefined, { 200: Blob }, never, 'download'>;
  upload: OperationDefinition<undefined, { 200: string }, never, 'upload'>;
  socket: OperationDefinition<undefined, { 200: string }, never, 'socket'>;
  stream: OperationDefinition<undefined, { 200: string }, never, 'stream'>;
  httpStream: OperationDefinition<undefined, { 200: string }> & { stream: { frame: string } };
};
declare const client: OperationClient<Contract>;
declare const context: ShipQueryContext;
const define = defineShipReadBinding<Contract>();
const binding = define({
  operationId: 'read',
  safety: 'safe',
  inputKey: input => input.id,
  variantKey: null,
});
const options = shipQueryOptions(client, binding, { id: 'one' }, context);
void options;
const selected = injectShipQuery(client, binding, () => ({ id: 'one' }), context, {
  select: envelope => envelope.data?.title,
});
const title: string | undefined = selected.data();
void title;
const mutation = injectShipMutation(shipMutationOptions(client, 'write', context));
mutation.mutate({ title: 'typed' });
// @ts-expect-error operation inputs retain their contract fields
shipQueryOptions(client, binding, { id: 42 }, context);
// @ts-expect-error query retries remain owned by the operation policy
shipQueryOptions(client, binding, { id: 'one' }, context, { retry: true });
// @ts-expect-error mutation inputs retain their contract fields
mutation.mutate({ title: 42 });
// @ts-expect-error stable IDs must exist in the contract
define({ operationId: 'missing', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error download is not unary HTTP
define({ operationId: 'download', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error upload is not unary HTTP
define({ operationId: 'upload', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error socket is not unary HTTP
define({ operationId: 'socket', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error stream is not unary HTTP
define({ operationId: 'stream', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error an HTTP stream declaration is not a unary read
define({ operationId: 'httpStream', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error HTTP streams cannot be adapted into mutations either
shipMutationOptions(client, 'httpStream', context);
