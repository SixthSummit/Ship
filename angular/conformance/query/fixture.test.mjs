import { expect, it } from 'vitest';
import {
  createFixtureClient,
  failure,
  fixtureError,
  notModified,
  success,
} from './fixture-client.mjs';
import { createQueryFixtureServer } from './fixture-server.mjs';
import { createHttpFixtureClient } from './http-client.mjs';

it('proves the HTTP fixture body/status/header and conditional request boundary', async () => {
  const server = await createQueryFixtureServer();
  const client = createHttpFixtureClient(server.origin);
  try {
    server.enqueue(success({ id: 1 }, 200, 'v1'));
    expect((await client.call('fixture.read', {})).data).toEqual({ id: 1 });
    server.enqueue(success(undefined, 204));
    expect(await client.call('fixture.read', {})).toMatchObject({ status: 204, data: undefined });
    server.enqueue(notModified('v2'));
    expect(
      await client.call('fixture.read', {}, { headers: { 'if-none-match': 'v1' } })
    ).toMatchObject({ status: 304, notModified: true, headers: { etag: 'v2' } });
    expect(server.calls[2].options.headers['if-none-match']).toBe('v1');
    for (const status of [422, 409]) {
      server.enqueue(failure(status));
      expect((await client.call('fixture.write', {})).status).toBe(status);
    }
    const preflight = await globalThis.fetch(server.origin, {
      method: 'OPTIONS',
      headers: { origin: 'https://fixture.test' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('if-none-match');
    expect(preflight.headers.get('access-control-expose-headers')).toContain('etag');
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://fixture.test');
  } finally {
    await server.close();
  }
});

it('proves HTTP timeout and explicit abort without releasing held responses', async () => {
  const server = await createQueryFixtureServer();
  const client = createHttpFixtureClient(server.origin);
  try {
    server.enqueue(success('late'), { held: true });
    const controller = new globalThis.AbortController();
    const pending = client.call('fixture.read', {}, { signal: controller.signal });
    const aborted = expect(pending).rejects.toMatchObject({ name: 'OperationAbortedError' });
    await server.started(1);
    controller.abort();
    await aborted;
    server.enqueue(success('late'), { held: true });
    await expect(client.call('fixture.read', {}, { timeoutMs: 20 })).rejects.toMatchObject({
      name: 'OperationTimeoutError',
    });
  } finally {
    await server.close();
  }
});

it('supports concurrent authenticated HTTP fixture requests with explicit gates', async () => {
  const server = await createQueryFixtureServer();
  const client = createHttpFixtureClient(server.origin);
  try {
    const first = server.enqueue(success('alpha'), { held: true });
    const second = server.enqueue(success('beta'), { held: true });
    const alpha = client.call(
      'fixture.read',
      {},
      { headers: { authorization: 'Bearer fixture-alpha' } }
    );
    await server.started(1);
    const beta = client.call(
      'fixture.read',
      {},
      { headers: { authorization: 'Bearer fixture-beta' } }
    );
    await server.started(2);
    second();
    expect((await beta).data).toBe('beta');
    first();
    expect((await alpha).data).toBe('alpha');
    expect(server.calls.map(call => call.options.headers.authorization)).toEqual([
      'Bearer fixture-alpha',
      'Bearer fixture-beta',
    ]);
  } finally {
    await server.close();
  }
});

it('fails explicitly on unplanned calls, network failures, and malformed fixture requests', async () => {
  const fixture = createFixtureClient();
  await expect(fixture.call('missing', {})).rejects.toThrow('Unplanned');
  const failure = fixtureError('OperationNetworkError');
  fixture.enqueue(failure);
  await expect(fixture.call('read', {})).rejects.toBe(failure);
  const server = await createQueryFixtureServer();
  try {
    expect(
      (await globalThis.fetch(server.origin, { method: 'POST', body: 'invalid' })).status
    ).toBe(500);
  } finally {
    await server.close();
  }
  await expect(createHttpFixtureClient(server.origin).call('read', {})).rejects.toThrow();
});

it('records dynamic plans and rejects a pre-aborted cooperative call', async () => {
  const fixture = createFixtureClient();
  fixture.enqueue(call => success(call.input));
  expect((await fixture.call('read', 'input')).data).toBe('input');
  const controller = new globalThis.AbortController();
  controller.abort();
  fixture.enqueue(success('late'), { held: true });
  await expect(fixture.call('read', {}, { signal: controller.signal })).rejects.toMatchObject({
    name: 'OperationAbortedError',
  });
});
