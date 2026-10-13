import {
  createOperationRequestPolicy,
  OperationAbortedError,
  OperationPolicyError,
  type OperationPolicyMap,
  OperationTimeoutError,
  ProtocolError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationDownload,
  filenameFromDisposition,
  type OperationDownloadBinding,
} from './create-operation-download';

interface DownloadContract {
  readonly 'reports.download': {
    readonly input: { readonly params: { readonly reportId: string } };
    readonly success: { readonly 200: Uint8Array };
    readonly errors: 'REPORT_NOT_FOUND' | 'AUTHENTICATION_ERROR' | 'UNAVAILABLE';
    readonly transport: 'download';
  };
}

const policies: OperationPolicyMap<DownloadContract> = {
  'reports.download': {
    authentication: 'optional',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
    retry: { maxAttempts: 2, statuses: [503] },
    refreshAuthentication: true,
  },
};

const binding: OperationDownloadBinding<DownloadContract, 'reports.download'> = {
  request: input => ({
    url: `https://api.example.test/reports/${input.params.reportId}`,
    headers: { accept: 'application/pdf' },
  }),
  successStatuses: [200],
  declaredErrors: ['REPORT_NOT_FOUND', 'AUTHENTICATION_ERROR', 'UNAVAILABLE'],
  contentTypes: ['application/pdf'],
};

function policy(
  overrides: Parameters<typeof createOperationRequestPolicy<DownloadContract>>[0] = {
    policies,
  }
) {
  return createOperationRequestPolicy<DownloadContract>({
    policies,
    allowedOrigins: ['https://api.example.test'],
    ...overrides,
  });
}

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function failure(status: number, code: string, headers: HeadersInit = {}): Response {
  return response(
    JSON.stringify({
      success: false,
      error: { code, message: code, details: { safe: true }, additive: 'kept' },
    }),
    { status, headers: { 'content-type': 'application/json', ...headers } }
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createOperationDownload', () => {
  it('settles once when a body failure races caller abort', async () => {
    const caller = new AbortController();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'stream',
      fetch: async () =>
        response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
          { headers: { 'content-type': 'application/pdf' } }
        ),
    });
    const result = await download.start(
      { params: { reportId: 'race' } },
      { signal: caller.signal }
    );
    if (!result.ok) throw new Error('expected success');
    const read = expect(result.data.getReader().read()).rejects.toBeInstanceOf(
      OperationAbortedError
    );
    body.error(new Error('body failed'));
    caller.abort();
    await read;
    expect(download.status()).toBe('aborted');
    expect(download.cancel()).toBe(false);
  });

  it('keeps streaming timeout and transport errors observable after returning headers', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'stream',
      fetch: async () =>
        response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'application/pdf' },
        }),
    });
    const result = await download.start({ params: { reportId: 'timeout' } }, { timeoutMs: 10 });
    if (!result.ok) throw new Error('expected success');
    const read = expect(result.data.getReader().read()).rejects.toBeInstanceOf(
      OperationTimeoutError
    );
    await vi.advanceTimersByTimeAsync(10);
    await read;
    expect(download.error()).toBeInstanceOf(OperationTimeoutError);
    expect(download.status()).toBe('error');
    expect(download.cancel()).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('contains body read errors and does not let superseded streams update the new result', async () => {
    let body: ReadableStreamDefaultController<Uint8Array>;
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'stream',
      fetch: async () =>
        response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
          { headers: { 'content-type': 'application/pdf' } }
        ),
    });
    const first = await download.start({ params: { reportId: 'first' } });
    if (!first.ok) throw new Error('expected success');
    const read = expect(first.data.getReader().read()).rejects.toBeInstanceOf(
      OperationAbortedError
    );
    const second = await download.start({ params: { reportId: 'second' } });
    await read;
    if (!second.ok) throw new Error('expected success');
    expect(download.status()).toBe('downloading');
    const failed = expect(second.data.getReader().read()).rejects.toThrow('broken body');
    body!.error(new Error('broken body'));
    await failed;
    expect(download.status()).toBe('error');
    expect(download.error()).toBeInstanceOf(TransportError);
    expect(download.cancel()).toBe(false);
  });

  it.each(['caller', 'helper', 'consumer'] as const)(
    'owns streaming cancellation until %s cancellation',
    async mode => {
      const caller = new AbortController();
      let fetchSignal: AbortSignal | null | undefined;
      const cancel = vi.fn();
      const download = createOperationDownload(policy(), 'reports.download', binding, {
        representation: 'stream',
        fetch: async (_url, init) => {
          fetchSignal = init?.signal;
          return response(new ReadableStream({ cancel }), {
            headers: { 'content-type': 'application/pdf' },
          });
        },
      });
      const result = await download.start(
        { params: { reportId: 'stream' } },
        { signal: caller.signal }
      );
      if (!result.ok) throw new Error('expected success');
      expect(download.status()).toBe('downloading');
      expect(download.pending()).toBe(true);
      if (mode === 'consumer') await result.data.cancel();
      else {
        const read = result.data.getReader().read();
        const rejected = expect(read).rejects.toBeInstanceOf(OperationAbortedError);
        if (mode === 'caller') caller.abort();
        else expect(download.cancel()).toBe(true);
        await rejected;
      }
      expect(fetchSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(download.status()).toBe('aborted');
      expect(download.cancel()).toBe(false);
    }
  );
  it('preserves exact bytes, status, filename, and browser-readable metadata', async () => {
    const fetchMock = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
      expect(new Headers(init?.headers).get('accept')).toBe('application/pdf');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer current-token');
      return response(new Uint8Array([0, 1, 2, 255]), {
        status: 200,
        headers: {
          'content-type': 'application/pdf; charset=binary',
          'content-disposition': `attachment; filename*=UTF-8''quarterly%20report.pdf`,
          'x-request-id': 'request-server',
          etag: '"report-v1"',
        },
      });
    });
    const download = createOperationDownload(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        credentials: { kind: 'bearer', getToken: async () => 'current-token' },
      }),
      'reports.download',
      binding,
      { representation: 'arrayBuffer', fetch: fetchMock }
    );

    const result = await download.start({ params: { reportId: 'report-1' } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect([...new Uint8Array(result.data)]).toEqual([0, 1, 2, 255]);
    expect(result).toMatchObject({
      status: 200,
      filename: 'quarterly report.pdf',
      headers: { requestId: 'request-server', etag: '"report-v1"' },
    });
    expect(download.status()).toBe('complete');
    expect(download.pending()).toBe(false);
    expect(download.value()).toBe(result.data);
    expect(download.failure()).toBeUndefined();
    expect(download.error()).toBeUndefined();
  });

  it('returns a Blob without parsing successful bytes as JSON', async () => {
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: async () =>
        response('not-json', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    });

    const result = await download.start({ params: { reportId: 'report-2' } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    // Node Fetch and jsdom have distinct Blob constructors. Verify the returned bytes.
    const text =
      typeof result.data.text === 'function'
        ? await result.data.text()
        : await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(result.data);
          });
    expect(text).toBe('not-json');
    expect(result.data).toMatchObject({ size: 8, type: 'application/pdf' });
  });

  it('returns the response stream when explicitly requested', async () => {
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'stream',
      fetch: async () =>
        response('streamed', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    });

    const result = await download.start({ params: { reportId: 'stream' } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data).toBeInstanceOf(ReadableStream);
    expect(await new Response(result.data).text()).toBe('streamed');
    expect(download.status()).toBe('complete');
    expect(download.cancel()).toBe(false);
  });

  it('preserves declared JSON errors instead of returning their bytes', async () => {
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: async () => failure(404, 'REPORT_NOT_FOUND', { 'x-request-id': 'request-404' }),
    });

    const result = await download.start({ params: { reportId: 'missing' } });

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: {
        declared: true,
        code: 'REPORT_NOT_FOUND',
        details: { safe: true },
        requestId: 'request-404',
        extensions: { additive: 'kept' },
      },
    });
    expect(download.status()).toBe('failure');
    expect(download.failure()).toBe(result);
    expect(download.value()).toBeUndefined();
  });

  it('preserves an additive server code as an unknown application error', async () => {
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'arrayBuffer',
      fetch: async () => failure(409, 'REPORT_ARCHIVED'),
    });

    const result = await download.start({ params: { reportId: 'archived' } });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { declared: false, code: 'REPORT_ARCHIVED' },
    });
  });

  it('rejects non-JSON proxy failures and undeclared successful MIME types', async () => {
    const proxyDownload = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: async () =>
        response('<html>gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    });
    await expect(proxyDownload.start({ params: { reportId: 'proxy' } })).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-content-type',
      status: 502,
    });
    expect(proxyDownload.status()).toBe('error');
    expect(proxyDownload.error()).toBeInstanceOf(ProtocolError);

    const mimeDownload = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: async () =>
        response('wrong', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    await expect(mimeDownload.start({ params: { reportId: 'mime' } })).rejects.toMatchObject({
      reason: 'unexpected-content-type',
      receivedContentType: 'text/plain',
    });
  });

  it('rejects 304, undeclared success statuses, and missing stream bodies', async () => {
    const cases: Array<readonly [Response, string]> = [
      [response(null, { status: 304 }), 'unexpected-status'],
      [
        response('created', { status: 201, headers: { 'content-type': 'application/pdf' } }),
        'unexpected-status',
      ],
      [
        response(null, { status: 200, headers: { 'content-type': 'application/pdf' } }),
        'invalid-envelope',
      ],
    ];

    for (const [nextResponse, reason] of cases) {
      const download = createOperationDownload(policy(), 'reports.download', binding, {
        representation: 'stream',
        fetch: async () => nextResponse,
      });
      await expect(download.start({ params: { reportId: reason } })).rejects.toMatchObject({
        reason,
      });
    }
  });

  it('retries an approved safe failure while retaining one logical request ID', async () => {
    const delay = vi.fn(async () => undefined);
    const requestIds: Array<string | null> = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        requestIds.push(new Headers(init?.headers).get('x-request-id'));
        return failure(503, 'UNAVAILABLE', { 'retry-after': '2' });
      })
      .mockImplementationOnce(async (_url, init) => {
        requestIds.push(new Headers(init?.headers).get('x-request-id'));
        return response('ready', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      });
    const download = createOperationDownload(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        requestId: { generate: () => 'request-client' },
      }),
      'reports.download',
      binding,
      {
        representation: 'blob',
        fetch: fetchMock,
        delay,
      }
    );

    await expect(download.start({ params: { reportId: 'retry' } })).resolves.toMatchObject({
      ok: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
    expect(requestIds).toEqual(['request-client', 'request-client']);
  });

  it('refreshes authentication once and resolves a current token on the replay', async () => {
    const getToken = vi.fn(async ({ attempt }: { attempt: number }) => `token-${attempt}`);
    const refresh = vi.fn(async () => undefined);
    const tokens: Array<string | null> = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        tokens.push(new Headers(init?.headers).get('authorization'));
        return failure(401, 'AUTHENTICATION_ERROR');
      })
      .mockImplementationOnce(async (_url, init) => {
        tokens.push(new Headers(init?.headers).get('authorization'));
        return response('authenticated', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      });
    const download = createOperationDownload(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        credentials: { kind: 'bearer', getToken, refresh },
      }),
      'reports.download',
      binding,
      { representation: 'blob', fetch: fetchMock }
    );

    await download.start({ params: { reportId: 'private' } });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(tokens).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('blocks an unapproved origin before credentials or fetch are invoked', async () => {
    const getToken = vi.fn(async () => 'secret');
    const fetchMock = vi.fn<typeof fetch>();
    const download = createOperationDownload(
      createOperationRequestPolicy<DownloadContract>({
        policies,
        allowedOrigins: ['https://trusted.example.test'],
        credentials: { kind: 'bearer', getToken },
      }),
      'reports.download',
      binding,
      { representation: 'blob', fetch: fetchMock }
    );

    await expect(download.start({ params: { reportId: 'blocked' } })).rejects.toBeInstanceOf(
      OperationPolicyError
    );
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes network failures without leaking their message', async () => {
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: async () => Promise.reject(new TypeError('private proxy credential')),
    });

    const rejection = await download
      .start({ params: { reportId: 'network' } })
      .catch(error => error);

    expect(rejection).toBeInstanceOf(TransportError);
    expect(rejection).toMatchObject({ reason: 'network', causeName: 'TypeError' });
    expect(JSON.stringify(rejection)).not.toContain('private proxy credential');
  });

  it('cancels in-flight work and distinguishes timeout', async () => {
    const abortingFetch = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const cancelled = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: abortingFetch,
    });
    const pending = cancelled.start({ params: { reportId: 'cancel' } });
    const cancelledAssertion = expect(pending).rejects.toBeInstanceOf(OperationAbortedError);
    expect(cancelled.cancel()).toBe(true);
    await cancelledAssertion;
    expect(cancelled.status()).toBe('aborted');
    expect(cancelled.cancel()).toBe(false);

    vi.useFakeTimers();
    const timedOut = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: abortingFetch,
    });
    const deadline = timedOut.start({ params: { reportId: 'timeout' } }, { timeoutMs: 10 });
    const timeoutAssertion = expect(deadline).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await timeoutAssertion;
  });

  it('keeps stale completions from replacing a newer download', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>(resolve => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(async () =>
        response('new', { status: 200, headers: { 'content-type': 'application/pdf' } })
      );
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: fetchMock,
    });

    const stale = download.start({ params: { reportId: 'old' } });
    const staleAssertion = expect(stale).rejects.toBeInstanceOf(OperationAbortedError);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const current = await download.start({ params: { reportId: 'new' } });
    resolveFirst(response('old', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    await staleAssertion;

    expect(download.result()).toBe(current);
    expect(download.status()).toBe('complete');
  });

  it('resets or destroys state and rejects serializer failures as protocol errors', async () => {
    const download = createOperationDownload(policy(), 'reports.download', binding, {
      representation: 'blob',
      fetch: async () =>
        response('done', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    });
    await download.start({ params: { reportId: 'done' } });
    download.reset();
    expect(download.status()).toBe('idle');
    expect(download.result()).toBeUndefined();
    download.destroy();
    expect(download.status()).toBe('aborted');

    const brokenBinding: OperationDownloadBinding<DownloadContract, 'reports.download'> = {
      ...binding,
      request: () => {
        throw new Error('generated implementation detail');
      },
    };
    const broken = createOperationDownload(policy(), 'reports.download', brokenBinding, {
      representation: 'blob',
      fetch: vi.fn<typeof fetch>(),
    });
    await expect(broken.start({ params: { reportId: 'broken' } })).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'invalid-envelope',
    });
  });
});

describe('filenameFromDisposition', () => {
  it('prefers RFC 5987 filenames and strips path components', () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="fallback.pdf"; filename*=UTF-8''safe%20name.pdf`
      )
    ).toBe('safe name.pdf');
    expect(filenameFromDisposition('attachment; filename="../../unsafe.pdf"')).toBe('unsafe.pdf');
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''bad%ZZ.pdf`)).toBe('bad%ZZ.pdf');
    expect(filenameFromDisposition('inline')).toBeUndefined();
    expect(filenameFromDisposition(undefined)).toBeUndefined();
  });
});
