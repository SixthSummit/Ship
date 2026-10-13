import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type OperationCallOptions,
  type OperationClient,
  type OperationDefinition,
  type OperationResultOf,
} from '@sixthsummit/ship-angular/operations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provideShipQuery } from '../browser-provider/provide-ship-query';
import { SHIP_QUERY_CONTEXT } from '../browser-provider/ship-query-context-token';
import { injectShipQuery } from './inject-ship-query';

type Contract = { read: OperationDefinition<{ id: number }, { 200: { title: string } }, 'DENIED'> };
type Result = OperationResultOf<Contract, 'read'>;
const binding = {
  operationId: 'read',
  safety: 'safe',
  inputKey: (input: { id: number }) => input.id,
  variantKey: null,
} as const;
const success = (title: string): Result => ({
  ok: true,
  status: 200,
  data: { title },
  headers: { headers: {} },
});
const flush = () => TestBed.tick();
function setup(response?: () => Promise<Result>) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideShipQuery({ namespace: 'app', scopeKey: 'user1' }),
    ],
  });
  const context = TestBed.inject(SHIP_QUERY_CONTEXT);
  const call = vi.fn(
    (_operation: string, _input: { id: number }, _call?: OperationCallOptions) =>
      response?.() ?? Promise.resolve(success(`SECRET_${context.scope.capture().scopeKey}`))
  );
  const client = { call } as unknown as OperationClient<Contract>;
  return { context, client, call };
}
afterEach(() => TestBed.resetTestingModule());

describe('injectShipQuery scope projection', () => {
  it('hides previous identity data before the Angular effect turn and after change resolves', async () => {
    const f = setup();
    const query = TestBed.runInInjectionContext(() =>
      injectShipQuery(f.client, binding, () => ({ id: 1 }), f.context)
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.data.title).toBe('SECRET_user1');
    });
    expect(query.isSuccess()).toBe(true);
    expect(query.isFetched()).toBe(true);
    const changing = f.context.scope.change('user2');
    expect(query.data()).toBeUndefined();
    expect(query.error()).toBeNull();
    expect(query.isSuccess()).toBe(false);
    expect(query.isFetched()).toBe(false);
    expect(query.status()).toBe('pending');
    expect(query.fetchStatus()).toBe('idle');
    expect(query.dataUpdatedAt()).toBe(0);
    expect(query.errorUpdatedAt()).toBe(0);
    expect(query.failureReason()).toBeNull();
    expect(query.failureCount()).toBe(0);
    await changing;
    expect(query.data()).toBeUndefined();
    expect(query.isSuccess()).toBe(false);
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.data.title).toBe('SECRET_user2');
    });
  });
  it('guards primitive selected values and tracks options factory changes', async () => {
    const f = setup();
    const prefix = signal('selected:');
    const query = TestBed.runInInjectionContext(() =>
      injectShipQuery(
        f.client,
        binding,
        () => ({ id: 1 }),
        f.context,
        () => {
          const value = prefix();
          return { select: envelope => `${value}${envelope.data.title}` };
        }
      )
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()).toBe('selected:SECRET_user1');
    });
    prefix.set('changed:');
    await vi.waitFor(() => {
      flush();
      expect(query.data()).toBe('changed:SECRET_user1');
    });
    const changing = f.context.scope.change('user2');
    expect(query.data()).toBeUndefined();
    await changing;
    prefix.set('new:');
    await vi.waitFor(() => {
      flush();
      expect(query.data()).toBe('new:SECRET_user2');
    });
  });
  it('exposes the original error in its scope and masks error flags and timestamps on transition', async () => {
    const secret = new Error('SECRET_user1_failure');
    const f = setup(async () => {
      throw secret;
    });
    const query = TestBed.runInInjectionContext(() =>
      injectShipQuery(f.client, binding, () => ({ id: 1 }), f.context)
    );
    await vi.waitFor(() => {
      flush();
      expect(query.error()).toBe(secret);
    });
    expect(query.isError()).toBe(true);
    expect(query.failureReason()).toBe(secret);
    const changing = f.context.scope.change('user2');
    expect(query.error()).toBeNull();
    expect(query.failureReason()).toBeNull();
    expect(query.isError()).toBe(false);
    expect(query.isLoadingError()).toBe(false);
    expect(query.errorUpdatedAt()).toBe(0);
    expect(query.errorUpdateCount()).toBe(0);
    await changing;
    expect(query.error()).toBeNull();
  });
  it('guards a custom select exception and preserves the original error', async () => {
    const f = setup();
    const secret = new Error('SECRET_SELECT_user1');
    const query = TestBed.runInInjectionContext(() =>
      injectShipQuery(f.client, binding, () => ({ id: 1 }), f.context, {
        select: () => {
          throw secret;
        },
      })
    );
    await vi.waitFor(() => {
      flush();
      expect(query.error()).toBe(secret);
    });
    const changing = f.context.scope.change('user2');
    expect(query.error()).toBeNull();
    await changing;
    expect(query.error()).toBeNull();
  });
  it('masks old pending fetching state and ignores a non-cooperative late completion', async () => {
    let finish!: (result: Result) => void;
    const f = setup(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const query = TestBed.runInInjectionContext(() =>
      injectShipQuery(f.client, binding, () => ({ id: 1 }), f.context)
    );
    await vi.waitFor(() => {
      flush();
      expect(f.call).toHaveBeenCalledOnce();
    });
    expect(query.isFetching()).toBe(true);
    const changing = f.context.scope.change('user2');
    expect(query.isFetching()).toBe(false);
    expect(query.isLoading()).toBe(false);
    expect(query.fetchStatus()).toBe('idle');
    expect(query.data()).toBeUndefined();
    await changing;
    finish(success('SECRET_late_user1'));
    await Promise.resolve();
    expect(query.data()).toBeUndefined();
  });
  it('returns selected refetch data and preserves errors for throwOnError', async () => {
    const state: { failure?: Error } = {};
    const f = setup(async () => {
      if (state.failure) throw state.failure;
      return success('visible');
    });
    const query = TestBed.runInInjectionContext(() =>
      injectShipQuery(f.client, binding, () => ({ id: 1 }), f.context, {
        select: envelope => envelope.data.title,
      })
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()).toBe('visible');
    });
    const result = await query.refetch();
    expect(result.data).toBe('visible');
    state.failure = new Error('original');
    await expect(query.refetch({ throwOnError: true })).rejects.toBe(state.failure);
  });
  it('does not return old generation data through an awaited refetch', async () => {
    let finish!: (result: Result) => void;
    let wait = false;
    const f = setup(() =>
      wait
        ? new Promise(resolve => {
            finish = resolve;
          })
        : Promise.resolve(success('SECRET_user1'))
    );
    const query = TestBed.runInInjectionContext(() =>
      injectShipQuery(f.client, binding, () => ({ id: 1 }), f.context)
    );
    await vi.waitFor(() => {
      flush();
      expect(query.data()?.data.title).toBe('SECRET_user1');
    });
    wait = true;
    const refetch = query.refetch();
    const rejected = expect(refetch).rejects.toMatchObject({ name: 'OperationAbortedError' });
    await f.context.scope.change('user2');
    finish(success('SECRET_late_user1'));
    await rejected;
    expect(query.data()).toBeUndefined();
  });
  it('keeps disabled inputs empty and rejects manual refetch without client work', async () => {
    const f = setup();
    const query = TestBed.runInInjectionContext(() =>
      injectShipQuery(f.client, binding, () => undefined, f.context)
    );
    flush();
    expect(query.data()).toBeUndefined();
    expect(query.isFetching()).toBe(false);
    await expect(query.refetch()).rejects.toMatchObject({ name: 'OperationAbortedError' });
    expect(f.call).not.toHaveBeenCalled();
  });
});
