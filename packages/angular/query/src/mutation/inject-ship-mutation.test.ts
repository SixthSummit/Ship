import {
  ApplicationRef,
  createEnvironmentInjector,
  EnvironmentInjector,
  PendingTasks,
  provideZonelessChangeDetection,
  runInInjectionContext,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  OperationAbortedError,
  OperationApiError,
  type OperationCallOptions,
  type OperationClient,
  type OperationDefinition,
  OperationMutationBusyError,
  type OperationResultOf,
} from '@sixthsummit/ship-angular/operations';
import { QueryClient } from '@tanstack/angular-query-experimental';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPendingTaskClient } from '../../../operations/src/create-pending-task-client';
import { createShipQueryScope } from '../scope/create-ship-query-scope';
import { injectShipMutation } from './inject-ship-mutation';
import { shipMutationOptions } from './ship-mutation-options';

type Contract = { edit: OperationDefinition<string, { 200: string }, 'DENIED'> };
type Result = OperationResultOf<Contract, 'edit'>;
const injectors: EnvironmentInjector[] = [];
const clients: QueryClient[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function success(data: string): Result {
  return { ok: true, status: 200, data, headers: { headers: {} } };
}
function fixture(
  handler: (input: string, options?: OperationCallOptions) => Promise<Result>,
  tracked = false
) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const parent = TestBed.inject(EnvironmentInjector);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  clients.push(queryClient);
  const scope = createShipQueryScope({ namespace: 'app', scopeKey: 'a', cache: queryClient });
  const client: OperationClient<Contract> = {
    call: ((_id, input, options) => handler(input, options)) as OperationClient<Contract>['call'],
  };
  const boundary = tracked ? createPendingTaskClient(client, TestBed.inject(PendingTasks)) : client;
  const definition = shipMutationOptions(boundary, 'edit', { queryClient, scope });
  const injector = createEnvironmentInjector(
    [{ provide: QueryClient, useValue: queryClient }],
    parent
  );
  injectors.push(injector);
  const view = runInInjectionContext(injector, () => injectShipMutation(definition));
  return { scope, queryClient, definition, injector, view };
}

afterEach(() => {
  for (const injector of injectors.splice(0)) if (!injector.destroyed) injector.destroy();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe('injectShipMutation', () => {
  it.each(['success', 'failure'] as const)(
    'hides all old %s fields before an Angular effect flush',
    async outcome => {
      const { view, scope } = fixture(async input =>
        outcome === 'success'
          ? success(input)
          : {
              ok: false,
              status: 403,
              headers: { headers: {} },
              error: { code: 'DENIED', declared: true, message: input },
            }
      );
      await view.mutateAsync('private-input').catch(() => undefined);
      expect(view.variables()).toBe('private-input');
      expect(view.submittedAt()).toBeGreaterThan(0);
      if (outcome === 'success') {
        expect(view.data()?.data).toBe('private-input');
        expect(view.isSuccess()).toBe(true);
      } else {
        expect(view.error()).toBeInstanceOf(OperationApiError);
        expect(view.isError()).toBe(true);
        expect(view.failureReason()).toBeInstanceOf(OperationApiError);
        expect(view.failureCount()).toBe(1);
      }
      const changed = scope.change('b');
      // No tick, await, or effect flush precedes these assertions.
      expect(view.data()).toBeUndefined();
      expect(view.error()).toBeNull();
      expect(view.variables()).toBeUndefined();
      expect(view.status()).toBe('idle');
      expect(view.isIdle()).toBe(true);
      expect(view.isError()).toBe(false);
      expect(view.isSuccess()).toBe(false);
      expect(view.isPending()).toBe(false);
      expect(view.isPaused()).toBe(false);
      expect(view.failureCount()).toBe(0);
      expect(view.failureReason()).toBeNull();
      expect(view.submittedAt()).toBe(0);
      await changed;
    }
  );

  it('cancels and hides old pending work, then starts the new generation without waiting for old IO', async () => {
    const oldResponse = deferred<Result>();
    const handler = vi.fn(async input => (input === 'old' ? oldResponse.promise : success(input)));
    const { view, scope, queryClient } = fixture(handler);
    const old = view.mutateAsync('old').catch(error => error);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(view.isPending()).toBe(true);
    const changed = scope.change('b');
    expect(view.variables()).toBeUndefined();
    expect(view.isPending()).toBe(false);
    await expect(view.mutateAsync('during transition')).rejects.toBeInstanceOf(
      OperationAbortedError
    );
    await changed;
    await expect(view.mutateAsync('new')).resolves.toMatchObject({ data: 'new' });
    expect(await old).toBeInstanceOf(OperationAbortedError);
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every(record => record.options.mutationKey?.[4] === 1)
    ).toBe(true);
    oldResponse.resolve(success('old private data'));
    await Promise.resolve();
    expect(view.data()?.data).toBe('new');
    expect(view.variables()).toBe('new');
  });

  it('retains original errors and default overlap rejection in the native observer', async () => {
    const response = deferred<Result>();
    const handler = vi.fn(() => response.promise);
    const { view } = fixture(handler);
    const old = view.mutateAsync('first');
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await expect(view.mutateAsync('second')).rejects.toBeInstanceOf(OperationMutationBusyError);
    expect(view.error()).toBeInstanceOf(OperationMutationBusyError);
    response.resolve(success('first'));
    await old;
    view.reset();
    expect(view.status()).toBe('idle');
  });

  it('resets only the observer during active work and cancels without resetting the executor', async () => {
    const handler = vi.fn(() => new Promise<Result>(() => {}));
    const { view } = fixture(handler);
    const pending = view.mutateAsync('value').catch(error => error);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(() => view.reset()).not.toThrow();
    expect(view.status()).toBe('idle');
    expect(view.cancel()).toBe(true);
    expect(await pending).toBeInstanceOf(OperationAbortedError);
    expect(view.cancel()).toBe(false);
  });

  it.each([false, true])(
    'adds no tracking beyond the operation boundary (tracked=%s)',
    async tracked => {
      const response = deferred<Result>();
      const handler = vi.fn(() => response.promise);
      const { view } = fixture(handler, tracked);
      const app = TestBed.inject(ApplicationRef);
      await app.whenStable();
      const add = vi.spyOn(TestBed.inject(PendingTasks), 'add');
      const pending = view.mutateAsync('a');
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      expect(add).toHaveBeenCalledTimes(tracked ? 1 : 0);
      if (!tracked) await app.whenStable();
      response.resolve(success('a'));
      await pending;
      await app.whenStable();
      expect(add).toHaveBeenCalledTimes(tracked ? 1 : 0);
    }
  );

  it('handles fire-and-forget errors and masks completion after injector destruction', async () => {
    const response = deferred<Result>();
    const handler = vi.fn(() => response.promise);
    const { view, injector } = fixture(handler);
    view.mutate('a');
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    injector.destroy();
    expect(view.variables()).toBeUndefined();
    expect(view.status()).toBe('idle');
    response.resolve(success('private'));
    await Promise.resolve();
    await expect(view.mutateAsync('again')).rejects.toBeInstanceOf(OperationAbortedError);
  });

  it('supports explicit injection and rejects unowned definitions and foreign clients', () => {
    const { definition, injector } = fixture(async input => success(input));
    expect(injectShipMutation(definition, { injector }).isIdle()).toBe(true);
    expect(() => injectShipMutation((() => ({})) as never, { injector })).toThrow(
      'shipMutationOptions'
    );
    const foreignClient = new QueryClient();
    clients.push(foreignClient);
    const foreign = createEnvironmentInjector(
      [{ provide: QueryClient, useValue: foreignClient }],
      injector
    );
    injectors.push(foreign);
    expect(() => injectShipMutation(definition, { injector: foreign })).toThrow(
      'owned QueryClient'
    );
  });
});
