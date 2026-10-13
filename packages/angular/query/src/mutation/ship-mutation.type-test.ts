import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import { MutationObserver } from '@tanstack/angular-query-experimental';
import type { ShipQueryContext } from '../browser-provider/ship-query-context';
import { injectShipMutation } from './inject-ship-mutation';
import { shipMutationOptions } from './ship-mutation-options';

interface Contract {
  readonly operations: {
    readonly edit: {
      readonly transport: 'http';
      readonly input: { readonly name: string };
      readonly result: {
        readonly ok: true;
        readonly status: 200;
        readonly data: { readonly name: string };
      };
    };
    readonly events: {
      readonly transport: 'http';
      readonly input: void;
      readonly stream: { readonly frame: string };
      readonly result: { readonly ok: true; readonly status: 200; readonly data: string };
    };
  };
}
declare const client: OperationClient<Contract>;
declare const context: ShipQueryContext;
const factory = shipMutationOptions(client, 'edit', context, {
  optimistic: {
    apply: (input, effects) => {
      effects.run(() => undefined);
      return input.name;
    },
    rollback: (snapshot, _outcome, effects) => {
      const name: string = snapshot;
      void name;
      effects.run(() => undefined);
    },
  },
});
const observer = new MutationObserver(context.queryClient, factory());
observer.mutate({ name: 'updated' });
const mutation = injectShipMutation(factory);
mutation.mutate({ name: 'updated' });
const name: string | undefined = mutation.data()?.data.name;
const status: 200 | undefined = mutation.data()?.result.status;
void [name, status];

// @ts-expect-error the input comes from the declared operation
mutation.mutate({ name: 5 });
// @ts-expect-error HTTP stream declarations are not unary mutations
shipMutationOptions(client, 'events', context);
// @ts-expect-error callers cannot replace the native retry policy
shipMutationOptions(client, 'edit', context, { retry: 3 });
// @ts-expect-error callers cannot replace the native mutation function
shipMutationOptions(client, 'edit', context, { mutationFn: () => null });
// @ts-expect-error observers do not accept per-call side effects outside captured scope guards
mutation.mutate({ name: 'updated' }, { onSuccess: () => undefined });
