import { check, rejects } from './assert.mjs';
import {
  createFixtureClient,
  failure,
  fixtureError,
  notModified,
  success,
} from './fixture-client.mjs';

/** This runner has no dependency on the reference implementation or a test framework. */
export const queryScenarios = {
  async results(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser' });
    try {
      client.enqueue(success({ owner: 'alpha' }, 200, 'v1'));
      const result = await session.read({ id: 'one' });
      check(
        result.data.owner === 'alpha' && result.result.status === 200 && result.etag === 'v1',
        'success envelope and validator'
      );
      client.enqueue(success(undefined, 204));
      const empty = await session.read({ id: 'empty' });
      check(
        Object.hasOwn(empty, 'data') && empty.data === undefined && empty.result.status === 204,
        '204 has a defined envelope'
      );
      for (const status of [422, 409]) {
        const expected = failure(status);
        client.enqueue(expected);
        await rejects(
          () => session.read({ id: `failure-${status}` }),
          error =>
            error.name === 'OperationApiError' &&
            error.status === expected.status &&
            error.code === expected.error.code &&
            error.declared === expected.error.declared &&
            error.error === expected.error &&
            error.headers === expected.headers &&
            error.details === expected.error.details &&
            error.requestId === expected.headers.requestId,
          'declared failure remains lossless'
        );
      }
      const timeout = fixtureError('OperationTimeoutError');
      client.enqueue(timeout);
      await rejects(
        () => session.read({ id: 'timeout' }),
        error => error === timeout,
        'timeout identity'
      );
      const abort = new globalThis.AbortController();
      client.enqueue(success('late'), { held: true });
      const pending = session.read({ id: 'abort' }, { signal: abort.signal });
      const rejection = rejects(
        () => pending,
        error => error.name === 'OperationAbortedError',
        'caller abort'
      );
      await client.started(6);
      abort.abort();
      await rejection;
    } finally {
      await session.destroy();
    }
  },
  async etag(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser' });
    try {
      const input = { id: 'etag' };
      client.enqueue(success('body', 200, 'v1'));
      await session.read(input);
      client.enqueue(notModified());
      const revalidated = await session.read(input, { force: true });
      check(
        revalidated.data === 'body' &&
          revalidated.result.status === 304 &&
          revalidated.etag === 'v1',
        '304 retains body and omitted validator'
      );
      check(
        new globalThis.Headers(client.calls[1].options.headers).get('if-none-match') === 'v1',
        'revalidation sends validator'
      );
      client.enqueue(notModified('v2'));
      const next = await session.read(input, { force: true });
      check(next.etag === 'v2', '304 replaces validator when supplied');
      client.enqueue(notModified());
      await rejects(
        () => session.read({ id: 'no-body' }),
        error =>
          error.name === 'ProtocolError' &&
          error.kind === 'protocol' &&
          error.reason === 'unexpected-status',
        'uncached 304 rejected'
      );
    } finally {
      await session.destroy();
    }
  },
  async deduplication(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser' });
    try {
      const release = client.enqueue(success('one'), { held: true });
      client.enqueue(success('one')); // A second call must be detected by counts, not an unplanned-call error.
      const first = session.read({ id: 'shared' });
      const second = session.read({ id: 'shared' });
      await client.started(1);
      release();
      const values = await Promise.all([first, second]);
      check(client.calls.length === 1, 'one transport call for overlapping reads');
      check(
        values.every(value => value.data === 'one'),
        'deduplicated results'
      );
      await session.read({ id: 'shared' });
      check(client.calls.length === 1, 'fresh cache suppresses transport');
    } finally {
      await session.destroy();
    }
  },
  async invalidation(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser' });
    try {
      client.enqueue(success('before'));
      await session.read({ id: 'selected' });
      client.enqueue(success('keep'));
      await session.read({ id: 'unrelated' });
      await session.invalidate({ id: 'selected' });
      client.enqueue(success('after'));
      await session.read({ id: 'selected' });
      client.enqueue(success('keep'));
      const keep = await session.read({ id: 'unrelated' });
      check(
        client.calls.length === 3 && keep.data === 'keep',
        'exact invalidation preserves unrelated cache'
      );
    } finally {
      await session.destroy();
    }
  },
  async pagination(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser' });
    try {
      client.enqueue(success({ items: [1], next: 'two' }));
      await session.page({ id: 'list' }, null);
      client.enqueue(success({ items: [2], next: null }));
      const pages = await session.page({ id: 'list' }, 'two');
      check(
        pages.pages.length === 2 &&
          pages.pages[0].data.items[0] === 1 &&
          pages.pages[1].data.items[0] === 2,
        'ordered page envelopes'
      );
      check(
        pages.pageParams[0] === null && pages.pageParams[1] === 'two',
        'page parameters remain aligned'
      );
      check(client.calls[1].input.cursor === 'two', 'cursor reaches operation input');
      client.enqueue(success('finite'));
      check(
        (await session.read({ id: 'list' })).data === 'finite',
        'finite and infinite keys do not collide'
      );
    } finally {
      await session.destroy();
    }
  },
  async scope(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser' });
    try {
      client.enqueue(success('private-alpha'));
      await session.read({ id: 'private' });
      const view = session.view({ id: 'private' });
      check(view().data?.data === 'private-alpha', 'view exposes current user');
      const release = client.enqueue(success('late-alpha'), { held: true, cooperative: false });
      const pending = session.read({ id: 'private' }, { force: true });
      const rejected = rejects(
        () => pending,
        error => error.name === 'OperationAbortedError',
        'old-scope read rejects'
      );
      await client.started(2);
      const changing = session.changeScope('beta');
      check(
        view().data === undefined && view().error == null,
        'old observer state hidden before framework tick'
      );
      await changing;
      check(view().data === undefined, 'old observer state hidden after transition');
      release();
      await rejected;
      client.enqueue(success('private-beta'));
      check(
        (await session.read({ id: 'private' })).data === 'private-beta',
        'new scope can execute after old transport'
      );
      check(view().data?.data !== 'late-alpha', 'late transport cannot expose prior identity');
    } finally {
      await session.destroy();
    }
  },
  async rollback(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser' });
    let app = 'before';
    let rollbacks = 0;
    const mutation = session.mutation({
      optimistic: {
        apply: (_input, effects) => {
          const previous = app;
          effects.run(() => {
            app = 'optimistic';
          });
          return previous;
        },
        rollback: (previous, _outcome, effects) =>
          effects.run(() => {
            app = previous;
            rollbacks++;
          }),
      },
    });
    try {
      const release = client.enqueue(failure(), { held: true });
      const pending = mutation.execute({ id: 'edit' });
      const rejected = rejects(
        () => pending,
        error => error.status === 409,
        'mutation expected failure'
      );
      await client.started(1);
      check(app === 'optimistic', 'optimistic apply runs');
      await rejects(
        () => mutation.execute({ id: 'overlap' }),
        error => error.name === 'OperationMutationBusyError',
        'same-scope overlap rejected'
      );
      release();
      await rejected;
      check(app === 'before' && rollbacks === 1, 'one rollback restores optimistic state');
      client.enqueue(success('late'), { held: true });
      const interrupted = mutation.execute({ id: 'destroy' });
      const stopped = rejects(
        () => interrupted,
        error => error.name === 'OperationAbortedError',
        'owner destroy rejects active mutation'
      );
      await client.started(2);
      await mutation.destroy();
      await stopped;
      check(app === 'before' && rollbacks === 2, 'current-scope destroy restores optimism');
    } finally {
      await mutation.destroy();
      await session.destroy();
    }
  },
  async mutationScope(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser' });
    let finish;
    const callbackGate = new Promise(resolve => {
      finish = resolve;
    });
    let callbackStarted;
    const started = new Promise(resolve => {
      callbackStarted = resolve;
    });
    let effects = 0;
    const mutation = session.mutation({
      onSuccess: async (_result, _input, guard) => {
        callbackStarted();
        await callbackGate;
        guard.run(() => {
          effects++;
        });
      },
    });
    try {
      client.enqueue(success('alpha'));
      const pending = mutation.execute({ id: 'edit' });
      const stopped = rejects(
        () => pending,
        error => error.name === 'OperationAbortedError',
        'late mutation callback rejects'
      );
      await started;
      const changing = session.changeScope('beta');
      check(
        mutation.view().data === undefined && mutation.view().error == null,
        'mutation state hidden before framework tick'
      );
      await changing;
      finish();
      await stopped;
      check(effects === 0, 'late success callback cannot write after logout');
    } finally {
      finish();
      await mutation.destroy();
      await session.destroy();
    }
  },
  async retry(create) {
    const client = createFixtureClient();
    const session = await create({ client, scopeKey: 'alpha', mode: 'browser', policyRetry: 1 });
    try {
      client.enqueue(failure(503));
      client.enqueue(success('retried'));
      check((await session.read({ id: 'retry' })).data === 'retried', 'policy retry can recover');
      check(client.calls.length === 2, 'one policy retry without query retry multiplication');
      client.enqueue(failure(503));
      client.enqueue(failure(503));
      await rejects(
        () => session.read({ id: 'exhausted' }),
        error => error.status === 503,
        'policy retry exhaustion'
      );
      check(client.calls.length === 4, 'retry ceiling is exact');
    } finally {
      await session.destroy();
    }
  },
  async ssr(create) {
    const alphaClient = createFixtureClient();
    const betaClient = createFixtureClient();
    const alphaRequest = new globalThis.AbortController();
    const betaRequest = new globalThis.AbortController();
    const alpha = await create({
      client: alphaClient,
      scopeKey: 'alpha',
      mode: 'server',
      requestSignal: alphaRequest.signal,
      requestHeaders: { cookie: 'session=fixture-alpha' },
    });
    const beta = await create({
      client: betaClient,
      scopeKey: 'beta',
      mode: 'server',
      requestSignal: betaRequest.signal,
      requestHeaders: { cookie: 'session=fixture-beta' },
    });
    try {
      const releaseAlpha = alphaClient.enqueue(
        call => {
          check(
            new globalThis.Headers(call.options.headers).get('cookie') === 'session=fixture-alpha',
            'first request forwards its own allowed credentials'
          );
          return success({ authenticated: 'alpha' });
        },
        { held: true }
      );
      const releaseBeta = betaClient.enqueue(
        call => {
          check(
            new globalThis.Headers(call.options.headers).get('cookie') === 'session=fixture-beta',
            'second request forwards its own allowed credentials'
          );
          return success({ authenticated: 'beta' });
        },
        { held: true }
      );
      const first = alpha.read({ id: 'same' });
      const second = beta.read({ id: 'same' });
      await Promise.all([alphaClient.started(1), betaClient.started(1)]);
      releaseBeta();
      check((await second).data.authenticated === 'beta', 'second SSR request owns identity');
      releaseAlpha();
      check((await first).data.authenticated === 'alpha', 'first SSR request owns identity');
      check(
        alpha.clientIdentity !== beta.clientIdentity,
        'SSR requests own distinct native QueryClients'
      );
      alphaClient.enqueue(success('late'), { held: true });
      const pending = alpha.read({ id: 'abort' });
      const stopped = rejects(
        () => pending,
        error => error.name === 'OperationAbortedError' || alpha.isCancellation?.(error) === true,
        'request signal aborts SSR work'
      );
      await alphaClient.started(2);
      alphaRequest.abort();
      await stopped;
      check(
        (await beta.read({ id: 'same' })).data.authenticated === 'beta',
        'one SSR abort preserves other request'
      );
    } finally {
      await alpha.destroy();
      await beta.destroy();
    }
  },
};

export async function runQueryConformance(create, { kind = 'candidate', only } = {}) {
  const passed = [];
  const skipped = [];
  for (const [name, scenario] of Object.entries(queryScenarios)) {
    if (only && !only.includes(name)) {
      skipped.push(name);
      continue;
    }
    await scenario(create);
    passed.push(name);
  }
  return {
    kind,
    passed,
    skipped,
    acceptance:
      kind !== 'candidate'
        ? 'fixture-only'
        : skipped.length
          ? 'partial-scenarios'
          : 'adapter-scenarios',
  };
}
