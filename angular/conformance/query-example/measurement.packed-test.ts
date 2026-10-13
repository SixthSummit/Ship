import '@angular/compiler';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  Injector,
  inject,
  provideZonelessChangeDetection,
  runInInjectionContext,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  injectShipQuery,
  provideShipQuery,
  SHIP_QUERY_CONTEXT,
} from '@sixthsummit/ship-angular/query';
import { afterEach, expect, it, vi } from 'vitest';
import { createExampleFixture } from './fixture';
import { createBaselineWorkflow, createQueryWorkflow, detailBinding } from './workflow';

@Component({
  selector: 'measurement-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class MeasurementHost {
  readonly injector = inject(Injector);
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const destroy of cleanup.splice(0)) await destroy();
});
async function setup(mode: 'baseline' | 'query') {
  const element = document.createElement('measurement-host');
  document.body.append(element);
  const app = await bootstrapApplication(MeasurementHost, {
    providers: [
      provideZonelessChangeDetection(),
      ...(mode === 'query'
        ? [
            provideShipQuery({
              namespace: 'measurement.v1',
              scopeKey: 'tenant.alpha',
              freshness: { gcTime: Infinity },
            }),
          ]
        : []),
    ],
  });
  const host = app.components[0]!.instance as MeasurementHost;
  const fixture = createExampleFixture();
  fixture.delayMs.set(5);
  cleanup.push(async () => {
    app.destroy();
    element.remove();
  });
  return { app, host, fixture };
}
function inHost<T>(host: MeasurementHost, action: () => T): T {
  return runInInjectionContext(host.injector, action);
}
async function ready(app: ApplicationRef, check: () => void) {
  app.tick();
  await vi.waitFor(check);
}

it('measures the same baseline and Query workflow against the physical package', async () => {
  const baseline = await setup('baseline');
  const a = inHost(baseline.host, () => createBaselineWorkflow(baseline.fixture));
  const b = inHost(baseline.host, () => createBaselineWorkflow(baseline.fixture));
  await ready(baseline.app, () => {
    expect(a.detail.value()?.title).toBe('First');
    expect(b.detail.value()?.title).toBe('First');
    expect(b.list.value()?.items[0]?.title).toBe('First');
    expect(a.list.value()?.items[0]?.title).toBe('First');
    expect(b.list.value()?.items[0]?.title).toBe('First');
  });
  const baselineInitial = { ...baseline.fixture.counters() };
  expect(baselineInitial).toEqual({ list: 2, detail: 2, edit: 0 });
  a.selectedId.set(2);
  await ready(baseline.app, () => expect(a.detail.value()?.id).toBe(2));
  const baselineBeforeReturn = baseline.fixture.counters().detail;
  a.selectedId.set(1);
  await ready(baseline.app, () => expect(a.detail.value()?.id).toBe(1));
  const baselineReturnReads = baseline.fixture.counters().detail - baselineBeforeReturn;
  expect(baselineReturnReads).toBe(1);
  const baselineBeforeSave = { ...baseline.fixture.counters() };
  await a.save({ id: 1, title: 'Saved' });
  await ready(baseline.app, () => {
    expect(a.detail.value()?.title).toBe('Saved');
    expect(a.list.value()?.items[0]?.title).toBe('Saved');
  });
  expect(b.detail.value()?.title).toBe('First');
  expect(b.list.value()?.items[0]?.title).toBe('First');
  const baselineAfterSave = { ...baseline.fixture.counters() };
  expect(baselineAfterSave.detail - baselineBeforeSave.detail).toBe(1);
  expect(baselineAfterSave.list - baselineBeforeSave.list).toBe(1);

  const query = await setup('query');
  const context = query.app.injector.get(SHIP_QUERY_CONTEXT);
  const first = inHost(query.host, () => createQueryWorkflow(query.fixture, context));
  const second = inHost(query.host, () => createQueryWorkflow(query.fixture, context));
  await ready(query.app, () => {
    expect(first.detail.data()?.data.title).toBe('First');
    expect(second.detail.data()?.data.title).toBe('First');
    expect(first.list.data()?.data.items[0]?.title).toBe('First');
    expect(first.pages.data()?.pages[0]?.data.items[0]?.id).toBe(1);
  });
  const queryInitial = { ...query.fixture.counters() };
  expect(queryInitial).toEqual({ list: 2, detail: 1, edit: 0 });
  await first.prefetch(2);
  first.selectedId.set(2);
  await ready(query.app, () => expect(first.detail.data()?.data.id).toBe(2));
  const queryBeforeReturn = query.fixture.counters().detail;
  first.selectedId.set(1);
  await ready(query.app, () => expect(first.detail.data()?.data.id).toBe(1));
  const queryReturnReads = query.fixture.counters().detail - queryBeforeReturn;
  expect(queryReturnReads).toBe(0);
  const unrelated = inHost(query.host, () =>
    injectShipQuery(query.fixture.client, detailBinding, () => ({ id: 2 }), context)
  );
  await ready(query.app, () => expect(unrelated.data()?.data.title).toBe('Second'));
  const beforeSave = { ...query.fixture.counters() };
  const detailRequest = first.detail.data()?.result.headers.requestId;
  const unrelatedRequest = unrelated.data()?.result.headers.requestId;
  await first.save({ id: 1, title: 'Saved' });
  await ready(query.app, () => {
    expect(first.detail.data()?.data.title).toBe('Saved');
    expect(second.detail.data()?.data.title).toBe('Saved');
    expect(first.list.data()?.data.items[0]?.title).toBe('Saved');
    expect(first.pages.data()?.pages[0]?.data.items[0]?.title).toBe('Saved');
  });
  const afterSave = { ...query.fixture.counters() };
  expect(first.detail.data()?.result.headers.requestId).not.toBe(detailRequest);
  expect(unrelated.data()?.result.headers.requestId).toBe(unrelatedRequest);
  expect(afterSave.detail - beforeSave.detail).toBe(1);
  expect(afterSave.list - beforeSave.list).toBe(2);
  expect(unrelated.data()?.data.title).toBe('Second');
  query.fixture.delayMs.set(150);
  query.fixture.rejectNextEdit.set(true);
  const rejected = first.save({ id: 1, title: 'Rejected optimism' }).catch(error => error);
  await vi.waitFor(() => expect(first.detail.data()?.data.title).toBe('Rejected optimism'));
  expect(await rejected).toMatchObject({ status: 409, code: 'REJECTED' });
  await vi.waitFor(() => expect(first.detail.data()?.data.title).toBe('Saved'));
  const beforePages = query.fixture.counters().list;
  await Promise.all([first.pages.fetchNextPage(), first.pages.fetchNextPage()]);
  await vi.waitFor(() => expect(first.pages.data()?.pageParams).toEqual([null, 2]));
  const ids = first.pages.data()?.pages.flatMap(page => page.data.items.map(item => item.id));
  expect(ids).toEqual([1, 2]);
  expect(new Set(ids).size).toBe(2);
  expect(first.pages.data()?.pageParams).toEqual([null, 2]);
  expect(query.fixture.counters().list - beforePages).toBe(1);

  const report = {
    acceptance: 'preparation-pending-SNG-57-and-security',
    fixture: { delayMs: 5, rejectedEditDelayMs: 150, recordIds: [1, 2] },
    baseline: {
      initial: baselineInitial,
      returnNavigationReads: baselineReturnReads,
      beforeSave: baselineBeforeSave,
      afterSave: baselineAfterSave,
    },
    query: {
      initial: queryInitial,
      returnNavigationReads: queryReturnReads,
      beforeSave,
      afterSave,
      successRefresh: { detail: 1, list: 2, unrelatedDetail: 0 },
      rejectedEditRolledBack: true,
      nextPageRequests: 1,
      pageIds: ids,
      pageParams: first.pages.data()?.pageParams,
    },
    versions: JSON.parse(await readFile('measurement-versions.json', 'utf8')),
    archiveSha256: createHash('sha256')
      .update(await readFile('ship-angular.tgz'))
      .digest('hex'),
    sourceCommit: 'pending-final-commit',
    latencyClaim: null,
  };
  await writeFile('measurement-result.json', JSON.stringify(report, null, 2));
});

it.each(['tenant.beta', 'anonymous'])(
  'hides all prior identity state before a tick and ignores non-cooperative late reads for %s',
  async nextIdentity => {
    const query = await setup('query');
    const context = query.app.injector.get(SHIP_QUERY_CONTEXT);
    const cooperative = query.fixture.client;
    const nonCooperative = {
      ...query.fixture,
      client: {
        call: ((id, input, options) =>
          cooperative.call(
            id,
            input,
            Object.fromEntries(Object.entries(options ?? {}).filter(([name]) => name !== 'signal'))
          )) as typeof cooperative.call,
      },
    };
    const state = inHost(query.host, () => createQueryWorkflow(nonCooperative, context));
    await ready(query.app, () => expect(state.detail.data()?.data.title).toBe('First'));
    query.fixture.delayMs.set(100);
    const pending = state.detail.refetch({ throwOnError: true }).catch(error => error);
    await vi.waitFor(() => expect(query.fixture.counters().detail).toBe(2));
    const oldGeneration = context.scope.capture().generation;
    const changing =
      nextIdentity === 'anonymous' ? state.logout() : state.replaceIdentity(nextIdentity);
    expect(state.detail.data()).toBeUndefined();
    expect(state.list.data()).toBeUndefined();
    expect(state.pages.data()).toBeUndefined();
    expect(state.edit.data()).toBeUndefined();
    await changing;
    expect(await pending).toMatchObject({ name: 'OperationAbortedError' });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(state.detail.data()).toBeUndefined();
    expect(
      context.queryClient
        .getQueryCache()
        .getAll()
        .some(query => query.queryKey[4] === oldGeneration)
    ).toBe(false);
    expect(context.scope.capture().scopeKey).toBe(nextIdentity);
  }
);

it('keeps disabled baseline input and early rejected edits free of invented data or reloads', async () => {
  const query = await setup('query');
  const context = query.app.injector.get(SHIP_QUERY_CONTEXT);
  const state = inHost(query.host, () => createQueryWorkflow(query.fixture, context));
  query.fixture.rejectNextEdit.set(true);
  await expect(state.save({ id: 1, title: 'Early rejection' })).rejects.toMatchObject({
    status: 409,
  });
  const baseline = await setup('baseline');
  const resource = inHost(baseline.host, () => createBaselineWorkflow(baseline.fixture));
  resource.selectedId.set(undefined);
  await ready(baseline.app, () => expect(resource.list.value()?.items[0]?.id).toBe(1));
  expect(resource.detail.value()).toBeUndefined();
  const before = { ...baseline.fixture.counters() };
  baseline.fixture.rejectNextEdit.set(true);
  const result = await resource.save({ id: 1, title: 'Rejected baseline' });
  expect(result.ok).toBe(false);
  baseline.app.tick();
  expect(baseline.fixture.counters().list).toBe(before.list);
  expect(baseline.fixture.counters().detail).toBe(before.detail);
});
