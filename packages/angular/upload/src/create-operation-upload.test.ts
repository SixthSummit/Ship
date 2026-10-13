import {
  createOperationRequestPolicy,
  OperationAbortedError,
  OperationPolicyError,
  type OperationPolicyMap,
  OperationTimeoutError,
  ProtocolError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationUpload, type OperationUploadBinding } from './create-operation-upload';
import { OperationUploadValidationError } from './operation-upload-validation-error';

interface UploadContract {
  readonly 'assets.upload': {
    readonly input: {
      readonly params: { readonly folderId: string };
      readonly body: { readonly label: string };
      readonly files: { readonly asset: File };
    };
    readonly success: { readonly 201: { readonly id: string; readonly url: string } };
    readonly errors: 'AUTHENTICATION_ERROR' | 'VALIDATION_ERROR' | 'UNAVAILABLE';
    readonly transport: 'upload';
  };
}

const policies: OperationPolicyMap<UploadContract> = {
  'assets.upload': {
    authentication: 'optional',
    safety: 'unsafe',
    idempotency: 'supported',
    replayable: true,
    retry: { maxAttempts: 2, statuses: [503] },
    refreshAuthentication: true,
  },
};

const binding: OperationUploadBinding<UploadContract, 'assets.upload'> = {
  request: input => {
    const body = new FormData();
    body.append('asset', input.files.asset, input.files.asset.name);
    body.append('label', input.body.label);
    return {
      url: `https://api.example.test/folders/${input.params.folderId}/assets`,
      method: 'POST',
      headers: { accept: 'application/json' },
      body,
      files: [{ field: 'asset', file: input.files.asset }],
    };
  },
  successStatuses: [201],
  declaredErrors: ['AUTHENTICATION_ERROR', 'VALIDATION_ERROR', 'UNAVAILABLE'],
  fields: [
    {
      field: 'asset',
      minimumCount: 1,
      maximumCount: 1,
      maximumBytes: 10,
      acceptedMediaTypes: ['image/*'],
    },
  ],
  decodeSuccess: response => JSON.parse(response.bodyText) as { id: string; url: string },
};

function policy(
  overrides: Parameters<typeof createOperationRequestPolicy<UploadContract>>[0] = {
    policies,
  }
) {
  return createOperationRequestPolicy<UploadContract>({
    policies,
    allowedOrigins: ['https://api.example.test'],
    ...overrides,
  });
}

function input(file = new File(['image'], 'asset.png', { type: 'image/png' })) {
  return {
    params: { folderId: 'folder-1' },
    body: { label: 'Avatar' },
    files: { asset: file },
  } as const;
}

class MockXhr {
  static readonly instances: MockXhr[] = [];
  readonly upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
    onload: null as (() => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  status = 0;
  statusText = '';
  responseText = '';
  method = '';
  url = '';
  body: Document | XMLHttpRequestBodyInit | null = null;
  aborted = false;
  sendError: unknown;
  private readonly requestHeaders: Record<string, string> = {};
  private readonly responseHeaders: Record<string, string> = {};

  constructor() {
    MockXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name.toLowerCase()] = value;
  }

  getRequestHeader(name: string): string | undefined {
    return this.requestHeaders[name.toLowerCase()];
  }

  getAllResponseHeaders(): string {
    return Object.entries(this.responseHeaders)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\r\n');
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  progress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ lengthComputable, loaded, total } as ProgressEvent);
  }

  finishUpload(): void {
    this.upload.onload?.();
  }

  respond(status: number, body: string, headers: Record<string, string> = {}): void {
    this.status = status;
    this.statusText = status >= 200 && status < 300 ? 'OK' : 'Failed';
    this.responseText = body;
    Object.assign(
      this.responseHeaders,
      Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
      )
    );
    this.onload?.();
  }

  failNetwork(): void {
    this.onerror?.();
  }
}

const createXhr = (): XMLHttpRequest => new MockXhr() as unknown as XMLHttpRequest;
const lastXhr = (): MockXhr => MockXhr.instances[MockXhr.instances.length - 1]!;

async function waitForXhr(count = 1): Promise<void> {
  await vi.waitFor(() => expect(MockXhr.instances).toHaveLength(count));
}

function errorBody(code: string): string {
  return JSON.stringify({
    success: false,
    error: { code, message: code, details: { field: 'asset' }, additive: true },
  });
}

beforeEach(() => {
  MockXhr.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createOperationUpload', () => {
  it('uploads generated FormData with fresh bearer policy and monotonic progress', async () => {
    const getToken = vi.fn(async () => 'current-token');
    const upload = createOperationUpload(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        credentials: { kind: 'bearer', getToken },
        requestId: { generate: () => 'request-client' },
      }),
      'assets.upload',
      binding,
      { createXhr }
    );

    expect(upload.status()).toBe('idle');
    expect(upload.progress()).toBe(0);
    const pending = upload.start(input());
    await waitForXhr();
    const xhr = lastXhr();
    expect(xhr).toMatchObject({
      method: 'POST',
      url: 'https://api.example.test/folders/folder-1/assets',
      withCredentials: false,
    });
    expect(xhr.getRequestHeader('accept')).toBe('application/json');
    expect(xhr.getRequestHeader('authorization')).toBe('Bearer current-token');
    expect(xhr.getRequestHeader('x-request-id')).toBe('request-client');
    expect(xhr.body).toBeInstanceOf(FormData);
    expect((xhr.body as FormData).get('label')).toBe('Avatar');
    xhr.progress(4, 10);
    xhr.progress(2, 10);
    expect(upload.progress()).toBe(0.4);
    xhr.progress(1, 0);
    xhr.finishUpload();
    expect(upload.progress()).toBe(1);
    xhr.respond(201, JSON.stringify({ id: 'asset-1', url: '/assets/1' }), {
      'content-type': 'application/json',
      'x-request-id': 'request-server',
      etag: '"asset-v1"',
    });

    await expect(pending).resolves.toMatchObject({
      ok: true,
      status: 201,
      data: { id: 'asset-1', url: '/assets/1' },
      headers: { requestId: 'request-server', etag: '"asset-v1"' },
    });
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(upload.status()).toBe('complete');
    expect(upload.pending()).toBe(false);
    expect(upload.failure()).toBeUndefined();
    expect(upload.error()).toBeUndefined();
  });

  it('applies cookie credentials and current CSRF policy to XHR', async () => {
    const getCsrfToken = vi.fn(async () => 'csrf-current');
    const cookiePolicies: OperationPolicyMap<UploadContract> = {
      'assets.upload': { ...policies['assets.upload'], csrf: true },
    };
    const cookieUpload = createOperationUpload(
      createOperationRequestPolicy({
        policies: cookiePolicies,
        allowedOrigins: ['https://api.example.test'],
        credentials: {
          kind: 'cookie',
          credentials: 'include',
          getCsrfToken,
          csrfHeaderName: 'x-ship-csrf',
        },
      }),
      'assets.upload',
      binding,
      { createXhr }
    );
    const pending = cookieUpload.start(input());
    await waitForXhr();
    expect(lastXhr().withCredentials).toBe(true);
    expect(lastXhr().getRequestHeader('x-ship-csrf')).toBe('csrf-current');
    lastXhr().respond(201, JSON.stringify({ id: '1', url: '/1' }), {
      'content-type': 'application/json',
    });
    await pending;
    expect(getCsrfToken).toHaveBeenCalledTimes(1);
  });

  it('returns declared and additive unknown application failures', async () => {
    const upload = createOperationUpload(policy(), 'assets.upload', binding, { createXhr });
    const declared = upload.start(input());
    await waitForXhr();
    lastXhr().respond(422, errorBody('VALIDATION_ERROR'), {
      'content-type': 'application/json',
      'x-request-id': 'request-422',
    });
    await expect(declared).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: {
        declared: true,
        code: 'VALIDATION_ERROR',
        requestId: 'request-422',
        extensions: { additive: true },
      },
    });
    expect(upload.status()).toBe('failure');
    expect(upload.failure()).toMatchObject({ status: 422 });

    const unknown = upload.start(input());
    await waitForXhr(2);
    lastXhr().respond(409, errorBody('ASSET_EXISTS'), { 'content-type': 'application/json' });
    await expect(unknown).resolves.toMatchObject({
      ok: false,
      error: { declared: false, code: 'ASSET_EXISTS' },
    });
  });

  it('keeps proxy and malformed responses distinct from application failures', async () => {
    const upload = createOperationUpload(policy(), 'assets.upload', binding, { createXhr });
    const proxy = upload.start(input());
    await waitForXhr();
    lastXhr().respond(502, '<html>gateway</html>', { 'content-type': 'text/html' });
    await expect(proxy).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-content-type',
      status: 502,
    });

    const malformed = upload.start(input());
    await waitForXhr(2);
    lastXhr().respond(400, '{broken', { 'content-type': 'application/json' });
    await expect(malformed).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'invalid-json',
    });
    expect(upload.error()).toBeInstanceOf(ProtocolError);
  });

  it('validates count, bytes, and wildcard media type before credentials or XHR', async () => {
    const getToken = vi.fn(async () => 'secret');
    const emptyBinding: OperationUploadBinding<UploadContract, 'assets.upload'> = {
      ...binding,
      request: value => ({ ...binding.request(value), files: [] }),
    };
    const missing = createOperationUpload(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        credentials: { kind: 'bearer', getToken },
      }),
      'assets.upload',
      emptyBinding,
      { createXhr }
    );
    await expect(missing.start(input())).rejects.toMatchObject({
      issues: [{ reason: 'invalid-file-count', field: 'asset', actual: 0 }],
    });

    const invalidFile = new File(['this is too large'], 'notes.txt', { type: 'text/plain' });
    const invalid = createOperationUpload(policy(), 'assets.upload', binding, { createXhr });
    const rejection = await invalid.start(input(invalidFile)).catch(error => error);
    expect(rejection).toBeInstanceOf(OperationUploadValidationError);
    expect(rejection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'file-too-large', field: 'asset' }),
        expect.objectContaining({
          reason: 'unsupported-media-type',
          actualMediaType: 'text/plain',
        }),
      ])
    );
    expect(getToken).not.toHaveBeenCalled();
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('rejects undeclared success and generated decoder failures as protocol errors', async () => {
    const upload = createOperationUpload(policy(), 'assets.upload', binding, { createXhr });
    const unexpected = upload.start(input());
    await waitForXhr();
    lastXhr().respond(200, '{}', { 'content-type': 'application/json' });
    await expect(unexpected).rejects.toMatchObject({ reason: 'unexpected-status', status: 200 });

    const decodeBinding: OperationUploadBinding<UploadContract, 'assets.upload'> = {
      ...binding,
      decodeSuccess: () => {
        throw new Error('schema internals');
      },
    };
    const invalid = createOperationUpload(policy(), 'assets.upload', decodeBinding, { createXhr });
    const decoded = invalid.start(input());
    await waitForXhr(2);
    lastXhr().respond(201, '{}', { 'content-type': 'application/json' });
    await expect(decoded).rejects.toMatchObject({ reason: 'invalid-envelope', status: 201 });
  });

  it('retries only an idempotent replay and retains one request ID', async () => {
    const delay = vi.fn(async () => undefined);
    const upload = createOperationUpload(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        requestId: { generate: () => 'request-retry' },
      }),
      'assets.upload',
      binding,
      { createXhr, delay }
    );
    const pending = upload.start(input(), { idempotencyKey: 'upload-key' });
    await waitForXhr();
    lastXhr().respond(503, errorBody('UNAVAILABLE'), {
      'content-type': 'application/json',
      'retry-after': '1',
    });
    await waitForXhr(2);
    expect(lastXhr().getRequestHeader('x-request-id')).toBe('request-retry');
    expect(lastXhr().getRequestHeader('idempotency-key')).toBe('upload-key');
    lastXhr().respond(201, JSON.stringify({ id: '2', url: '/2' }), {
      'content-type': 'application/json',
    });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(delay).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));

    const noKey = upload.start(input());
    await waitForXhr(3);
    lastXhr().respond(503, errorBody('UNAVAILABLE'), { 'content-type': 'application/json' });
    await expect(noKey).resolves.toMatchObject({ ok: false, status: 503 });
    expect(MockXhr.instances).toHaveLength(3);
  });

  it('refreshes authentication once before replaying with a current token', async () => {
    const getToken = vi.fn(async ({ attempt }: { attempt: number }) => `token-${attempt}`);
    const refresh = vi.fn(async () => undefined);
    const upload = createOperationUpload(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        credentials: { kind: 'bearer', getToken, refresh },
      }),
      'assets.upload',
      binding,
      { createXhr }
    );
    const pending = upload.start(input());
    await waitForXhr();
    expect(lastXhr().getRequestHeader('authorization')).toBe('Bearer token-1');
    lastXhr().respond(401, errorBody('AUTHENTICATION_ERROR'), {
      'content-type': 'application/json',
    });
    await waitForXhr(2);
    expect(lastXhr().getRequestHeader('authorization')).toBe('Bearer token-2');
    lastXhr().respond(201, JSON.stringify({ id: '3', url: '/3' }), {
      'content-type': 'application/json',
    });
    await pending;

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('cancels, times out, and prevents stale XHR callbacks from mutating state', async () => {
    const upload = createOperationUpload(policy(), 'assets.upload', binding, { createXhr });
    const cancelled = upload.start(input());
    const cancelAssertion = expect(cancelled).rejects.toBeInstanceOf(OperationAbortedError);
    await waitForXhr();
    const canceledXhr = lastXhr();
    expect(upload.cancel()).toBe(true);
    await cancelAssertion;
    expect(canceledXhr.aborted).toBe(true);
    expect(upload.status()).toBe('aborted');
    expect(upload.cancel()).toBe(false);

    vi.useFakeTimers();
    const timed = upload.start(input(), { timeoutMs: 10 });
    const timeoutAssertion = expect(timed).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await timeoutAssertion;
    expect(upload.status()).toBe('error');
  });

  it('supersedes an upload and ignores callbacks from the old generation', async () => {
    const upload = createOperationUpload(policy(), 'assets.upload', binding, { createXhr });
    const old = upload.start(input());
    const oldAssertion = expect(old).rejects.toBeInstanceOf(OperationAbortedError);
    await waitForXhr();
    const oldXhr = lastXhr();
    const current = upload.start(input());
    await oldAssertion;
    await waitForXhr(2);
    oldXhr.progress(10, 10);
    oldXhr.respond(201, JSON.stringify({ id: 'old', url: '/old' }), {
      'content-type': 'application/json',
    });
    expect(upload.progress()).toBe(0);
    lastXhr().respond(201, JSON.stringify({ id: 'new', url: '/new' }), {
      'content-type': 'application/json',
    });
    await expect(current).resolves.toMatchObject({ data: { id: 'new' } });
  });

  it('normalizes XHR network and synchronous send failures without leaking details', async () => {
    const upload = createOperationUpload(policy(), 'assets.upload', binding, { createXhr });
    const network = upload.start(input());
    await waitForXhr();
    lastXhr().failNetwork();
    await expect(network).rejects.toBeInstanceOf(TransportError);

    const createThrowingXhr = () => {
      const xhr = new MockXhr();
      xhr.sendError = new TypeError('private browser detail');
      return xhr as unknown as XMLHttpRequest;
    };
    const throwing = createOperationUpload(policy(), 'assets.upload', binding, {
      createXhr: createThrowingXhr,
    });
    const rejection = await throwing.start(input()).catch(error => error);
    expect(rejection).toMatchObject({ name: 'TransportError', causeName: 'TypeError' });
    expect(JSON.stringify(rejection)).not.toContain('private browser detail');
  });

  it('blocks unapproved origins and remains inert without an XHR runtime', async () => {
    const getToken = vi.fn(async () => 'secret');
    const blocked = createOperationUpload(
      createOperationRequestPolicy<UploadContract>({
        policies,
        allowedOrigins: ['https://trusted.example.test'],
        credentials: { kind: 'bearer', getToken },
      }),
      'assets.upload',
      binding,
      { createXhr }
    );
    await expect(blocked.start(input())).rejects.toBeInstanceOf(OperationPolicyError);
    expect(getToken).not.toHaveBeenCalled();
    expect(MockXhr.instances).toHaveLength(0);

    vi.stubGlobal('XMLHttpRequest', undefined);
    const inert = createOperationUpload(policy(), 'assets.upload', binding);
    await expect(inert.start(input())).rejects.toMatchObject({
      name: 'TransportError',
      reason: 'unavailable',
    });
  });

  it('resets, destroys, and contains serializer failures', async () => {
    const upload = createOperationUpload(policy(), 'assets.upload', binding, { createXhr });
    const pending = upload.start(input());
    const resetAssertion = expect(pending).rejects.toBeInstanceOf(OperationAbortedError);
    await waitForXhr();
    upload.reset();
    await resetAssertion;
    expect(upload.status()).toBe('idle');
    expect(upload.progress()).toBe(0);
    expect(upload.result()).toBeUndefined();
    upload.destroy();
    expect(upload.status()).toBe('aborted');

    const brokenBinding: OperationUploadBinding<UploadContract, 'assets.upload'> = {
      ...binding,
      request: () => {
        throw new Error('generated detail');
      },
    };
    const broken = createOperationUpload(policy(), 'assets.upload', brokenBinding, { createXhr });
    await expect(broken.start(input())).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'invalid-envelope',
    });
  });
});
