import { computed, DestroyRef, inject, signal } from '@angular/core';
import {
  createOperationMutation,
  createOperationResource,
} from '@sixthsummit/ship-angular/operations';
import {
  createShipQueryKey,
  defineShipReadBinding,
  injectShipInfiniteQuery,
  injectShipMutation,
  injectShipQuery,
  invalidateShipQueries,
  type ShipQueryContext,
  type ShipQueryEnvelope,
  shipMutationOptions,
  shipQueryOptions,
  updateShipQueryData,
} from '@sixthsummit/ship-angular/query';
import type { createExampleFixture, ExampleContract, Item } from './fixture';

const define = defineShipReadBinding<ExampleContract>();
export const listBinding = define({
  operationId: 'list',
  safety: 'safe',
  inputKey: input => input.cursor,
  variantKey: 'example.v1',
});
export const detailBinding = define({
  operationId: 'detail',
  safety: 'safe',
  inputKey: input => input.id,
  variantKey: 'example.v1',
});

/** Call inside an Angular injection context. Each resource has its own lifetime and data. */
export function createBaselineWorkflow(fixture: ReturnType<typeof createExampleFixture>) {
  const selectedId = signal<number | undefined>(1);
  const list = createOperationResource(fixture.client, 'list', () => ({ cursor: null }));
  const detail = createOperationResource(fixture.client, 'detail', () => {
    const id = selectedId();
    return id === undefined ? undefined : { id };
  });
  const edit = createOperationMutation(fixture.client, 'edit');
  inject(DestroyRef).onDestroy(() => {
    list.destroy();
    detail.destroy();
    edit.cancel();
  });
  return {
    selectedId,
    list,
    detail,
    edit,
    async save(item: Item) {
      const result = await edit.execute(item);
      if (result.ok) {
        list.reload();
        detail.reload();
      }
      return result;
    },
  };
}

/** Call once inside the application-owned feature injector. Share returned state with views. */
export function createQueryWorkflow(
  fixture: ReturnType<typeof createExampleFixture>,
  context: ShipQueryContext
) {
  const selectedId = signal<number | undefined>(1);
  const detailInput = computed(() => {
    const id = selectedId();
    return id === undefined ? undefined : { id };
  });
  const list = injectShipQuery(fixture.client, listBinding, () => ({ cursor: null }), context);
  const detail = injectShipQuery(fixture.client, detailBinding, detailInput, context);
  const pages = injectShipInfiniteQuery(
    fixture.client,
    listBinding,
    () => ({ cursor: null }),
    context,
    {
      initialPageParam: null as number | null,
      buildInput: (_base, cursor) => ({ cursor }),
      getNextPageParam: page => page.data.next ?? undefined,
    }
  );
  const factory = shipMutationOptions<
    ExampleContract,
    'edit',
    ShipQueryEnvelope<ExampleContract, 'detail'> | undefined
  >(fixture.client, 'edit', context, {
    optimistic: {
      apply: (item, effects) => {
        const key = createShipQueryKey(detailBinding, { id: item.id }, effects.scope, 'finite');
        const before =
          context.queryClient.getQueryData<ShipQueryEnvelope<ExampleContract, 'detail'>>(key);
        effects.run(() => {
          if (before !== undefined)
            updateShipQueryData<ShipQueryEnvelope<ExampleContract, 'detail'>>(
              context,
              key,
              () => ({ ...before, data: item }),
              effects.scope
            );
        });
        return before;
      },
      rollback: (before, _outcome, effects) => {
        if (before !== undefined)
          effects.run(() => {
            updateShipQueryData<ShipQueryEnvelope<ExampleContract, 'detail'>>(
              context,
              createShipQueryKey(detailBinding, { id: before.data.id }, effects.scope, 'finite'),
              () => before,
              effects.scope
            );
          });
      },
    },
    onSuccess: async (_envelope, item, effects) => {
      if (!effects.isCurrent()) return;
      await invalidateShipQueries(
        context,
        [
          { kind: 'operation', operationId: 'list' },
          {
            kind: 'exact',
            key: createShipQueryKey(detailBinding, { id: item.id }, effects.scope, 'finite'),
          },
        ],
        effects.scope
      );
    },
  });
  // This owner ends the factory lifetime. A view that shares the factory must only detach its observer.
  inject(DestroyRef).onDestroy(() => {
    void factory.destroy();
  });
  const edit = injectShipMutation(factory);
  return {
    selectedId,
    list,
    detail,
    pages,
    edit,
    save: (item: Item) => edit.mutateAsync(item),
    prefetch: (id: number) =>
      context.queryClient.prefetchQuery(
        shipQueryOptions(fixture.client, detailBinding, { id }, context)
      ),
    async replaceIdentity(scopeKey: string) {
      selectedId.set(undefined);
      await context.scope.change(scopeKey);
    },
    async logout() {
      selectedId.set(undefined);
      await context.scope.change('anonymous');
    },
  };
}
