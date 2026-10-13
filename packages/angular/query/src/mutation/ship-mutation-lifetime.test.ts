import type { OperationClient, OperationDefinition } from '@sixthsummit/ship-angular/operations';
import { MutationObserver, QueryClient } from '@tanstack/angular-query-experimental';
import { expect, it, vi } from 'vitest';
import { createShipQueryScope } from '../scope/create-ship-query-scope';
import { shipMutationOptions } from './ship-mutation-options';

type Contract = { edit: OperationDefinition<string, { 200: string }> };
it('rolls back an applied optimistic update when its same-scope factory is destroyed', async () => {
  const queryClient = new QueryClient();
  const scope = createShipQueryScope({ namespace: 'app', scopeKey: 'a', cache: queryClient });
  const cacheKey = ['ship-query', 1, 'app', 'a', 0, 'finite', 'list', null, null];
  queryClient.setQueryData(cacheKey, 'original');
  const call = vi.fn(() => new Promise(() => {}));
  const client = { call } as unknown as OperationClient<Contract>;
  const rollback = vi.fn(
    (previous: string, _outcome: unknown, effects: { run(effect: () => void): boolean }) => {
      effects.run(() => queryClient.setQueryData(cacheKey, previous));
    }
  );
  const factory = shipMutationOptions(
    client,
    'edit',
    { queryClient, scope },
    {
      optimistic: {
        apply: (_input, effects) => {
          const previous = queryClient.getQueryData<string>(cacheKey)!;
          effects.run(() => queryClient.setQueryData(cacheKey, 'optimistic'));
          return previous;
        },
        rollback,
      },
    }
  );
  const observer = new MutationObserver(queryClient, factory());
  const pending = observer.mutate('input').catch(error => error);
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  expect(queryClient.getQueryData(cacheKey)).toBe('optimistic');
  await factory.destroy();
  await pending;
  expect(scope.isCurrent(scope.capture())).toBe(true);
  expect(rollback).toHaveBeenCalledOnce();
  expect(queryClient.getQueryData(cacheKey)).toBe('original');
  queryClient.clear();
  await scope.destroy();
});

import {
  createEnvironmentInjector,
  EnvironmentInjector,
  provideZonelessChangeDetection,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { injectShipMutation } from './inject-ship-mutation';

it('keeps a shared stable mutation factory usable when one observer injector is destroyed', async () => {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const queryClient = new QueryClient();
  const scope = createShipQueryScope({ namespace: 'app', scopeKey: 'a', cache: queryClient });
  const client = {
    call: vi.fn(async () => ({ ok: true, status: 200, data: 'saved', headers: { headers: {} } })),
  } as unknown as OperationClient<Contract>;
  const definition = shipMutationOptions(client, 'edit', { queryClient, scope });
  const parent = TestBed.inject(EnvironmentInjector);
  const first = createEnvironmentInjector(
    [{ provide: QueryClient, useValue: queryClient }],
    parent
  );
  const second = createEnvironmentInjector(
    [{ provide: QueryClient, useValue: queryClient }],
    parent
  );
  injectShipMutation(definition, { injector: first });
  const alive = injectShipMutation(definition, { injector: second });
  try {
    first.destroy();
    expect(scope.isCurrent(scope.capture())).toBe(true);
    await expect(alive.mutateAsync('new')).resolves.toMatchObject({ data: 'saved' });
  } finally {
    if (!first.destroyed) first.destroy();
    second.destroy();
    queryClient.clear();
    await scope.destroy();
  }
});
