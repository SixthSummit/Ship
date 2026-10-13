import type { OperationClient, OperationDefinition } from '@sixthsummit/ship-angular/operations';
import { executeRead } from './execute-read';

type Contract = {
  read: OperationDefinition<{ id: string }, { 200: { title: string } }, 'MISSING'>;
  download: OperationDefinition<{ id: string }, { 200: Blob }, never, 'download'>;
  streaming: OperationDefinition<undefined, { 200: unknown }> & { stream: { frame: string } };
};
declare const client: OperationClient<Contract>;
const common = {
  client,
  scope: 1,
  scopePort: {
    isCurrent: (_scope: number) => true,
    signal: (_scope: number) => new AbortController().signal,
  },
};
const read = executeRead({
  ...common,
  binding: { operationId: 'read', safety: 'safe' },
  input: { id: 'a' },
});
void read.then(envelope => {
  const title: string = envelope.data.title;
  void title;
});
// @ts-expect-error operation IDs must exist
executeRead({ ...common, binding: { operationId: 'missing', safety: 'safe' }, input: { id: 'a' } });
// @ts-expect-error inputs retain the operation contract
executeRead({ ...common, binding: { operationId: 'read', safety: 'safe' }, input: { id: 1 } });
executeRead({
  ...common,
  // @ts-expect-error download operations cannot use the unary query executor
  binding: { operationId: 'download', safety: 'safe' },
  input: { id: 'a' },
});
// @ts-expect-error HTTP stream operations cannot use the unary query executor
executeRead({ ...common, binding: { operationId: 'streaming', safety: 'safe' }, input: undefined });
// @ts-expect-error reads require an explicit safe declaration
executeRead({ ...common, binding: { operationId: 'read', safety: 'unsafe' }, input: { id: 'a' } });
