import type { OperationDefinition } from '../../../operations/src/operation-contract';
import { createShipQueryKey } from './create-ship-query-key';
import { defineShipReadBinding } from './ship-read-binding';

type Contract = {
  get: OperationDefinition<{ id: string }, { 200: { name: string } }>;
  write: OperationDefinition<{ body: string }, { 204: undefined }>;
  download: OperationDefinition<{ id: string }, { 200: Blob }, never, 'download'>;
  stream: OperationDefinition<Record<string, never>, { 200: string }, never, 'stream'>;
  httpStream: OperationDefinition<Record<string, never>, { 200: string }> & {
    stream: { frame: string };
  };
};
const define = defineShipReadBinding<Contract>();
const read = define({ operationId: 'get', safety: 'safe', inputKey: i => i.id, variantKey: null });
createShipQueryKey(
  read,
  { id: '1' },
  { namespace: 'api@1', scopeKey: 'anonymous', generation: 0 },
  'finite'
);
// HTTP transport alone does not imply safety. Writes require an explicit safe declaration too.
define({ operationId: 'write', safety: 'safe', inputKey: i => i.body, variantKey: null });
// @ts-expect-error unknown operation ID
define({ operationId: 'missing', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error download is not a unary HTTP operation
define({ operationId: 'download', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error stream transport is not unary HTTP
define({ operationId: 'stream', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error declared HTTP stream must also be excluded
define({ operationId: 'httpStream', safety: 'safe', inputKey: () => null, variantKey: null });
// @ts-expect-error safe declaration is mandatory
define({ operationId: 'get', inputKey: i => i.id, variantKey: null });
// @ts-expect-error unsafe operations cannot be used as query reads
define({ operationId: 'get', safety: 'unsafe', inputKey: i => i.id, variantKey: null });
// @ts-expect-error mapper receives only this operation's input
define({ operationId: 'get', safety: 'safe', inputKey: i => i.body, variantKey: null });
// @ts-expect-error key values cannot be undefined
define({ operationId: 'get', safety: 'safe', inputKey: () => undefined, variantKey: null });
createShipQueryKey(
  read,
  // @ts-expect-error input must match the binding's operation
  { body: 'x' },
  { namespace: 'api', scopeKey: 'a', generation: 0 },
  'finite'
);
createShipQueryKey(
  { ...read, variantKey: 'fr' },
  // @ts-expect-error spreading a binding must preserve its input check
  { body: 'x' },
  { namespace: 'api', scopeKey: 'a', generation: 0 },
  'finite'
);
