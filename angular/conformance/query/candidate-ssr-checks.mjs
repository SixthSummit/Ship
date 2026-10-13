import { check, rejects } from './assert.mjs';
import { createServerAdapter } from './candidate-server.mjs';
import { createFixtureClient, failure, fixtureError, success } from './fixture-client.mjs';

/** Real request applications and operation PendingTasks, independent of native query-helper tracking. */
export async function runCandidateSsrStability() {
  const passed = [];
  for (const outcome of ['success', 'failure', 'exception', 'retry', 'abort']) {
    const client = createFixtureClient();
    const request = new globalThis.AbortController();
    const session = await createServerAdapter({
      client,
      scopeKey: outcome,
      mode: 'server',
      requestSignal: request.signal,
      policyRetry: outcome === 'retry' ? 1 : 0,
    });
    try {
      await session.app.whenStable();
      const release = client.enqueue(
        outcome === 'failure'
          ? failure()
          : outcome === 'exception'
            ? fixtureError('OperationNetworkError')
            : outcome === 'retry'
              ? failure(503)
              : success('done'),
        { held: true }
      );
      if (outcome === 'retry') client.enqueue(success('retried'));
      const pending = session.read({ id: outcome });
      const observed = pending.then(
        value => ({ value }),
        error => ({ error })
      );
      await client.started(1);
      let stable = false;
      const stability = session.app.whenStable().then(() => {
        stable = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      check(!stable, `${outcome}: request PendingTasks blocks whenStable`);
      if (outcome === 'abort') request.abort();
      else release();
      const result = await observed;
      if (outcome === 'failure')
        check(result.error?.status === 409, 'SSR expected failure is preserved');
      else if (outcome === 'exception')
        check(
          result.error?.name === 'OperationNetworkError',
          'SSR transport exception is preserved'
        );
      else if (outcome === 'abort') {
        check(
          session.isCancellation(result.error) || result.error?.name === 'OperationAbortedError',
          'SSR cancellation has an explicit supported type'
        );
        check(client.calls[0].options.signal.aborted, 'request abort reaches operation transport');
      } else
        check(
          result.value?.data === (outcome === 'retry' ? 'retried' : 'done'),
          `${outcome}: SSR success body`
        );
      await stability;
      check(stable, `${outcome}: whenStable is released`);
      if (outcome === 'retry') check(client.calls.length === 2, 'SSR policy retry is bounded');
      passed.push(outcome);
    } finally {
      await session.destroy();
    }
  }
  const client = createFixtureClient();
  const session = await createServerAdapter({
    client,
    scopeKey: 'untracked',
    mode: 'server',
    trackPendingTasks: false,
  });
  try {
    await session.app.whenStable();
    const release = client.enqueue(success('untracked'), { held: true });
    const pending = session.read({ id: 'untracked' });
    await client.started(1);
    await session.app.whenStable();
    check(client.calls.length === 1, 'untracked imperative read remains in flight');
    release();
    await pending;
    await rejects(
      () => session.changeScope('other'),
      error => error instanceof Error,
      'SSR scope is fixed'
    );
    passed.push('trackPendingTasks:false');
  } finally {
    await session.destroy();
  }
  return { kind: 'real-ssr-stability', passed, skipped: [] };
}
