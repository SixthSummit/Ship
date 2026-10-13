import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideShipQuery, SHIP_QUERY_CONTEXT } from '@sixthsummit/ship-angular/query';
import { afterEach, expect, it, vi } from 'vitest';
import { createExampleFixture } from './fixture';
import { createBaselineWorkflow, createQueryWorkflow } from './workflow';

afterEach(() => {
  TestBed.resetTestingModule();
});
function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideShipQuery({ namespace: 'example', scopeKey: 'user.a' }),
    ],
  });
  const fixture = createExampleFixture();
  fixture.delayMs.set(1);
  return { fixture, context: TestBed.inject(SHIP_QUERY_CONTEXT) };
}
it('shares detail reads, prefetches the next detail, and preserves page cursor alignment', async () => {
  const { fixture, context } = setup();
  const a = TestBed.runInInjectionContext(() => createQueryWorkflow(fixture, context));
  const b = TestBed.runInInjectionContext(() => createQueryWorkflow(fixture, context));
  TestBed.tick();
  await vi.waitFor(() => expect(a.detail.data()?.data.title).toBe('First'));
  expect(b.detail.data()?.data.title).toBe('First');
  expect(fixture.counters().detail).toBe(1);
  await a.prefetch(2);
  a.selectedId.set(2);
  TestBed.tick();
  await vi.waitFor(() => expect(a.detail.data()?.data.title).toBe('Second'));
  expect(fixture.counters().detail).toBe(2);
  await vi.waitFor(() => expect(a.pages.hasNextPage()).toBe(true));
  await Promise.all([a.pages.fetchNextPage(), a.pages.fetchNextPage()]);
  await vi.waitFor(() => expect(a.pages.data()?.pageParams).toEqual([null, 2]));
  expect(a.pages.hasNextPage()).toBe(false);
  expect(fixture.counters().list).toBe(3); // One finite read, one initial infinite page, one next page.
});
it('restores the prior detail on rejection and hides all old identity results immediately', async () => {
  const { fixture, context } = setup();
  const state = TestBed.runInInjectionContext(() => createQueryWorkflow(fixture, context));
  TestBed.tick();
  await vi.waitFor(() => expect(state.detail.data()?.data.title).toBe('First'));
  fixture.delayMs.set(150);
  fixture.rejectNextEdit.set(true);
  const pending = state.save({ id: 1, title: 'Optimistic' }).catch(error => error);
  await vi.waitFor(() => expect(state.detail.data()?.data.title).toBe('Optimistic'));
  expect(await pending).toMatchObject({ code: 'REJECTED' });
  await vi.waitFor(() => expect(state.detail.data()?.data.title).toBe('First'));
  const changing = state.logout();
  expect(state.detail.data()).toBeUndefined();
  expect(state.edit.data()).toBeUndefined();
  await changing;
  expect(context.scope.capture().scopeKey).toBe('anonymous');
});
it('baseline owners perform separate reads and explicitly reload after edits', async () => {
  const { fixture } = setup();
  const a = TestBed.runInInjectionContext(() => createBaselineWorkflow(fixture));
  const b = TestBed.runInInjectionContext(() => createBaselineWorkflow(fixture));
  TestBed.tick();
  await vi.waitFor(() => expect(a.detail.value()?.title).toBe('First'));
  await vi.waitFor(() => expect(b.detail.value()?.title).toBe('First'));
  expect(fixture.counters().detail).toBe(2);
  await a.save({ id: 1, title: 'Saved' });
  TestBed.tick();
  await vi.waitFor(() => expect(a.detail.value()?.title).toBe('Saved'));
  expect(b.detail.value()?.title).toBe('First');
  expect(fixture.counters().detail).toBe(3);
});

it('cancels the controlled fixture delay without performing an edit', async () => {
  const fixture = createExampleFixture();
  fixture.delayMs.set(100);
  const controller = new AbortController();
  const pending = fixture.client.call(
    'edit',
    { id: 1, title: 'Never saved' },
    { signal: controller.signal }
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'OperationAbortedError' });
  fixture.delayMs.set(0);
  const result = await fixture.client.call('detail', { id: 1 });
  expect(result).toMatchObject({ ok: true, data: { title: 'First' } });
});

import { connectExampleEvents, type ExampleEvents } from './realtime';

it('invalidates on change, reconnect and loss, then disposes on scope replacement', async () => {
  const { context } = setup();
  let handlers!: Parameters<ExampleEvents['listen']>[0];
  const unlisten = vi.fn();
  const invalidate = vi.spyOn(context.queryClient, 'invalidateQueries');
  const owned = ['ship-query', 1, 'example', 'user.a', 0, 'finite', 'detail', null, 1];
  const unrelated = ['application', 'other'];
  const malformed = ['ship-query', 1, 'example', 'user.a', 0, 'finite', 'detail'];
  const nativeMutation = ['ship-query', 1, 'example', 'user.a', 0, 'mutation', 'detail', null, 1];
  context.queryClient.setQueryData(owned, 'owned');
  context.queryClient.setQueryData(unrelated, 'other');
  context.queryClient.setQueryData(malformed, 'malformed');
  context.queryClient.setQueryData(nativeMutation, 'native mutation');
  const dispose = connectExampleEvents(context, {
    listen: captured => {
      handlers = captured;
      return unlisten;
    },
  });
  handlers.changed();
  handlers.reconnected();
  handlers.dropped();
  expect(invalidate).toHaveBeenCalledTimes(3);
  expect(context.queryClient.getQueryState(owned)?.isInvalidated).toBe(true);
  expect(context.queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
  expect(context.queryClient.getQueryState(malformed)?.isInvalidated).toBe(false);
  expect(context.queryClient.getQueryState(nativeMutation)?.isInvalidated).toBe(false);
  await context.scope.change('user.b');
  expect(unlisten).toHaveBeenCalledOnce();
  handlers.changed();
  dispose();
  expect(invalidate).toHaveBeenCalledTimes(3);
  expect(unlisten).toHaveBeenCalledOnce();
});

it('refreshes authoritative reads after Query save and supports identity replacement', async () => {
  const { fixture, context } = setup();
  const state = TestBed.runInInjectionContext(() => createQueryWorkflow(fixture, context));
  TestBed.tick();
  await vi.waitFor(() => expect(state.detail.data()?.data.title).toBe('First'));
  await state.save({ id: 1, title: 'Saved' });
  await vi.waitFor(() => expect(state.detail.data()?.data.title).toBe('Saved'));
  expect(fixture.counters().edit).toBe(1);
  expect(fixture.counters().detail).toBe(2);
  await state.replaceIdentity('user.b');
  expect(state.detail.data()).toBeUndefined();
  state.selectedId.set(1);
  TestBed.tick();
  await vi.waitFor(() => expect(state.detail.data()?.data.title).toBe('Saved'));
});

it('does not invent a detail envelope before its first read and disables baseline input', async () => {
  const { fixture, context } = setup();
  const state = TestBed.runInInjectionContext(() => createQueryWorkflow(fixture, context));
  fixture.rejectNextEdit.set(true);
  await expect(state.save({ id: 1, title: 'Early' })).rejects.toMatchObject({ code: 'REJECTED' });
  const baseline = TestBed.runInInjectionContext(() => createBaselineWorkflow(fixture));
  baseline.selectedId.set(undefined);
  TestBed.tick();
  expect(baseline.detail.value()).toBeUndefined();
  const controller = new AbortController();
  controller.abort();
  await expect(
    fixture.client.call('detail', { id: 1 }, { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'OperationAbortedError' });
});
