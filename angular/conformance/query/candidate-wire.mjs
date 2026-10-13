import { check, rejects } from './assert.mjs';
import { createHttpFixtureClient } from './http-client.mjs';

/** Run the actual public adapter through real HTTP; transport counts come from the Node server. */
export async function runCandidateWire(create, control, origin) {
  const session = await create({
    client: createHttpFixtureClient(origin),
    scopeKey: 'wire',
    mode: 'browser',
  });
  try {
    const release = await control('enqueue', { data: 'wire-body', etag: 'wire-v1', held: true });
    const first = session.read({ id: 'wire' });
    const second = session.read({ id: 'wire' });
    await control('started', 1);
    await control('release', release);
    const responses = await Promise.all([first, second]);
    check(
      responses.every(response => response.data === 'wire-body'),
      'HTTP concurrent query bodies'
    );
    check(
      (await control('metrics')).count === 1,
      'HTTP query deduplication reaches one server request'
    );
    await session.read({ id: 'wire' });
    check((await control('metrics')).count === 1, 'HTTP fresh cache adds no server request');
    await control('enqueue', { status: 304 });
    const validated = await session.read({ id: 'wire' }, { force: true });
    check(
      validated.data === 'wire-body' &&
        validated.etag === 'wire-v1' &&
        validated.result.status === 304,
      'HTTP 304 retains actual body and validator'
    );
    const metrics = await control('metrics');
    check(
      metrics.count === 2 && metrics.headers[1]['if-none-match'] === 'wire-v1',
      'HTTP If-None-Match crosses the wire'
    );
    await control('enqueue', { data: 'late', held: true });
    const abort = new globalThis.AbortController();
    const pending = session.read({ id: 'wire-abort' }, { signal: abort.signal });
    const stopped = rejects(
      () => pending,
      error => error.name === 'OperationAbortedError',
      'HTTP query caller abort'
    );
    await control('started', 3);
    abort.abort();
    await stopped;
    check(await control('aborted', 3), 'HTTP server observes request cancellation');
    return {
      kind: 'physical-http-query',
      passed: ['deduplication', 'fresh-cache', 'etag-304', 'caller-abort'],
      requests: (await control('metrics')).count,
      skipped: [],
    };
  } finally {
    await session.destroy();
  }
}
