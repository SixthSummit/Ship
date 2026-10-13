import {
  EMPTY_RESPONSE_METADATA,
  OperationAbortedError,
  OperationApiError,
  type OperationCallOptions,
  type OperationClient,
  type OperationDefinition,
  type OperationResultOf,
  OperationTimeoutError,
  ProtocolError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { describe, expect, it, vi } from 'vitest';
import { adaptReadResult } from './adapt-read-result';
import { executeRead } from './execute-read';
import type { ShipQueryEnvelope } from './ship-query-envelope';

type Contract = {
  read: OperationDefinition<{ id: number }, { 200: { title: string }; 204: undefined }, 'MISSING'>;
};
type Result = OperationResultOf<Contract, 'read'>;
const snapshot = Object.freeze({ namespace: 'test.v1', scopeKey: 'user.a', generation: 1 });
const binding = { operationId: 'read', safety: 'safe' } as const;
const success = (etag?: string): Result => ({
  ok: true,
  status: 200,
  data: { title: 'read' },
  headers: {
    headers: { 'x-custom': 'metadata' },
    requestId: 'req-1',
    ...(etag === undefined ? {} : { etag }),
  },
});
const previous: ShipQueryEnvelope<Contract, 'read'> = {
  data: { title: 'cached' },
  result: success('v1') as ShipQueryEnvelope<Contract, 'read'>['result'],
  etag: 'v1',
};
function fixture(response: () => Promise<Result> = async () => success()) {
  const call = vi.fn((_operation: string, _input: unknown, _options?: OperationCallOptions) =>
    response()
  );
  const client = { call } as unknown as OperationClient<Contract>;
  const controller = new AbortController();
  let current = true;
  const scopePort = {
    isCurrent: (_scope: typeof snapshot) => current,
    signal: (_scope: typeof snapshot) => controller.signal,
  };
  return {
    args: { client, binding, input: { id: 1 }, scope: snapshot, scopePort },
    call,
    controller,
    expire(abort = true) {
      current = false;
      if (abort) controller.abort();
    },
  };
}

describe('read result boundary', () => {
  it('retains complete success and response metadata references', () => {
    const result = success('v2');
    const envelope = adaptReadResult<Contract, 'read'>(result);
    expect(envelope).toEqual({ data: { title: 'read' }, result, etag: 'v2' });
    expect(envelope.result).toBe(result);
    expect(envelope.result.headers).toBe(result.headers);
  });
  it('wraps a 204 undefined body in a defined envelope', () => {
    const result: Result = {
      ok: true,
      status: 204,
      data: undefined,
      headers: EMPTY_RESPONSE_METADATA,
    };
    expect(adaptReadResult<Contract, 'read'>(result)).toEqual({ data: undefined, result });
  });
  it.each([undefined, 'v2'])('retains cached body for 304 and carries validator %s', etag => {
    const result: Result = {
      ok: true,
      notModified: true,
      status: 304,
      headers: { headers: {}, ...(etag === undefined ? {} : { etag }) },
    };
    const envelope = adaptReadResult<Contract, 'read'>(result, previous);
    expect(envelope.data).toBe(previous.data);
    expect(envelope.result).toBe(result);
    expect(envelope.etag).toBe(etag ?? 'v1');
    expect(result.headers).not.toHaveProperty('etag', 'v1');
  });
  it('accepts cached undefined bodies and an absent validator', () => {
    const result: Result = {
      ok: true,
      notModified: true,
      status: 304,
      headers: EMPTY_RESPONSE_METADATA,
    };
    const empty = adaptReadResult<Contract, 'read'>({
      ok: true,
      status: 204,
      data: undefined,
      headers: EMPTY_RESPONSE_METADATA,
    });
    expect(adaptReadResult<Contract, 'read'>(result, empty)).toEqual({ data: undefined, result });
  });
  it('rejects a 304 without an envelope', () => {
    const result: Result = {
      ok: true,
      notModified: true,
      status: 304,
      headers: EMPTY_RESPONSE_METADATA,
    };
    expect(() => adaptReadResult<Contract, 'read'>(result)).toThrow(ProtocolError);
    try {
      adaptReadResult<Contract, 'read'>(result);
    } catch (error) {
      expect(error).toMatchObject({
        kind: 'protocol',
        reason: 'unexpected-status',
        status: 304,
        metadata: EMPTY_RESPONSE_METADATA,
      });
    }
  });
  it('discards a stale validator after a fresh result without etag', () => {
    expect(adaptReadResult<Contract, 'read'>(success(), previous)).not.toHaveProperty('etag');
  });
  it.each(['MISSING', 'IDEMPOTENT_IN_FLIGHT'])(
    'preserves complete failed %s result as OperationApiError',
    code => {
      const error = {
        code,
        declared: code === 'MISSING',
        message: 'failure',
        details: { retry: false },
        extensions: { additive: 1 },
        envelopeExtensions: { trace: 2 },
      };
      const result = {
        ok: false,
        status: code === 'MISSING' ? 404 : 409,
        error,
        headers: { headers: { 'x-request-id': 'req-2' }, requestId: 'req-2', retryAfterMs: 12 },
      } as Result;
      try {
        adaptReadResult<Contract, 'read'>(result);
        throw new Error('did not reject');
      } catch (caught) {
        expect(caught).toBeInstanceOf(OperationApiError);
        expect(caught).toMatchObject({
          code,
          status: result.status,
          requestId: 'req-2',
          details: error.details,
          error,
          headers: result.headers,
        });
        expect((caught as OperationApiError).error).toBe(error);
      }
    }
  );
});

describe('executeRead', () => {
  it('forwards controls and composes signals without enabling keepalive', async () => {
    const f = fixture();
    const caller = new AbortController();
    const observer = new AbortController();
    await executeRead({
      ...f.args,
      call: {
        signal: caller.signal,
        timeoutMs: 20,
        idempotencyKey: 'k',
        headers: { locale: 'en' },
      },
      signal: observer.signal,
    });
    expect(f.call).toHaveBeenCalledOnce();
    const options = f.call.mock.calls[0]?.[2];
    expect(options).toMatchObject({
      timeoutMs: 20,
      idempotencyKey: 'k',
      headers: { locale: 'en' },
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options).not.toHaveProperty('keepalive');
    caller.abort();
    expect(options?.signal?.aborted).toBe(false); // listeners removed after settlement
  });
  it('forwards opt-in keepalive and uses only the prior envelope validator', async () => {
    const f = fixture();
    await executeRead({
      ...f.args,
      previous,
      call: {
        keepalive: true,
        headers: { 'If-None-Match': 'wrong', 'IF-NONE-MATCH': 'wrong2', locale: 'fr' },
      },
    });
    expect(f.call.mock.calls[0]?.[2]).toMatchObject({
      keepalive: true,
      headers: { 'if-none-match': 'v1', locale: 'fr' },
    });
    expect(Object.keys(f.call.mock.calls[0]?.[2]?.headers ?? {})).toHaveLength(2);
  });
  it('does not send a caller validator without a cached envelope', async () => {
    const f = fixture();
    await executeRead({ ...f.args, call: { headers: { 'If-None-Match': 'wrong' } } });
    expect(f.call.mock.calls[0]?.[2]?.headers).toEqual({});
  });
  it('disables page ETag revalidation and rejects an unexpected 304', async () => {
    const f = fixture(async () => ({
      ok: true,
      notModified: true,
      status: 304,
      headers: EMPTY_RESPONSE_METADATA,
    }));
    await expect(executeRead({ ...f.args, previous, etag: false })).rejects.toBeInstanceOf(
      ProtocolError
    );
    expect(f.call.mock.calls[0]?.[2]?.headers).toEqual({});
  });
  it('rejects unsafe bindings when types are bypassed', async () => {
    const f = fixture();
    await expect(
      executeRead({ ...f.args, binding: { ...binding, safety: 'unsafe' as 'safe' } })
    ).rejects.toBeInstanceOf(TypeError);
    expect(f.call).not.toHaveBeenCalled();
  });
  it('rejects old scope before starting work', async () => {
    const f = fixture();
    f.expire(false);
    await expect(executeRead(f.args)).rejects.toBeInstanceOf(OperationAbortedError);
    expect(f.call).not.toHaveBeenCalled();
  });
  it('rejects a pre-aborted caller before starting work', async () => {
    const f = fixture();
    const caller = new AbortController();
    caller.abort();
    await expect(executeRead({ ...f.args, signal: caller.signal })).rejects.toBeInstanceOf(
      OperationAbortedError
    );
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['caller', 'observer', 'scope'])(
    'forwards %s cancellation and rejects late results',
    async source => {
      let finish!: (value: Result) => void;
      const f = fixture(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      );
      const caller = new AbortController();
      const observer = new AbortController();
      const task = executeRead({
        ...f.args,
        call: { signal: caller.signal },
        signal: observer.signal,
      });
      if (source === 'caller') caller.abort();
      if (source === 'observer') observer.abort();
      if (source === 'scope') f.expire();
      expect(f.call.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
      finish(success());
      await expect(task).rejects.toBeInstanceOf(OperationAbortedError);
    }
  );
  it('checks generation after await even when the client ignores cancellation', async () => {
    let finish!: (value: Result) => void;
    const f = fixture(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const task = executeRead(f.args);
    f.expire(false);
    finish(success());
    await expect(task).rejects.toBeInstanceOf(OperationAbortedError);
  });
  it('captures operation and call headers before awaiting work', async () => {
    let finish!: (value: Result) => void;
    const f = fixture(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const headers = { locale: 'en' };
    const call = { headers, keepalive: true };
    const task = executeRead({ ...f.args, call });
    headers.locale = 'fr';
    call.keepalive = false;
    expect(f.call.mock.calls[0]?.[2]).toMatchObject({ headers: { locale: 'en' }, keepalive: true });
    finish(success());
    await task;
  });
  it.each([
    new TransportError('offline', { reason: 'network' }),
    new OperationTimeoutError(100),
    new ProtocolError('invalid response', { reason: 'invalid-envelope' }),
    new OperationAbortedError(),
    new Error('programmer failure'),
  ])('preserves exceptional failure identity: %s', async failure => {
    const f = fixture(async () => {
      throw failure;
    });
    await expect(executeRead(f.args)).rejects.toBe(failure);
    expect(f.call).toHaveBeenCalledOnce();
  });
});
