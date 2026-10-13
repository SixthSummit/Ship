import {
  EMPTY_RESPONSE_METADATA,
  OperationAbortedError,
  type OperationClient,
  OperationPolicyError,
  type OperationResult,
  OperationTimeoutError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationSignedUpload,
  type OperationSignedUploadBinding,
} from './create-operation-signed-upload';
import { OperationUploadValidationError } from './operation-upload-validation-error';
import { SignedUploadProviderError } from './signed-upload-provider-error';

interface SignedContract {
  readonly 'assets.sign': {
    readonly input: {
      readonly body: { readonly name: string; readonly size: number; readonly type: string };
    };
    readonly success: {
      readonly 201: {
        readonly uploadUrl: string;
        readonly headers: Readonly<Record<string, string>>;
        readonly objectKey: string;
      };
    };
    readonly errors: 'SIGNING_DENIED';
    readonly transport: 'http';
  };
  readonly 'assets.complete': {
    readonly input: {
      readonly body: {
        readonly objectKey: string;
        readonly providerStatus: number;
      };
    };
    readonly success: { readonly 200: { readonly assetId: string } };
    readonly errors: 'COMPLETION_REJECTED';
    readonly transport: 'http';
  };
}

const binding: OperationSignedUploadBinding<SignedContract, 'assets.sign', 'assets.complete'> = {
  sign: {
    operation: 'assets.sign',
    input: file => ({ body: { name: file.name, size: file.size, type: file.type } }),
    destination: data => ({ url: data.uploadUrl, headers: data.headers, method: 'PUT' }),
  },
  file: {
    field: 'asset',
    minimumCount: 1,
    maximumCount: 1,
    maximumBytes: 10,
    acceptedMediaTypes: ['image/*'],
  },
  completion: {
    operation: 'assets.complete',
    input: ({ destination, provider }) => ({
      body: {
        objectKey: new URL(destination.url).pathname.slice(1),
        providerStatus: provider.status,
      },
    }),
  },
};

const signSuccess = {
  ok: true,
  status: 201,
  data: {
    uploadUrl: 'https://storage.example.test/object-1?signature=secret',
    headers: { 'content-type': 'image/png', 'x-provider-signature': 'provider-secret' },
    objectKey: 'object-1',
  },
  headers: EMPTY_RESPONSE_METADATA,
} as const;

const completionSuccess = {
  ok: true,
  status: 200,
  data: { assetId: 'asset-1' },
  headers: EMPTY_RESPONSE_METADATA,
} as const;

function clientFrom(
  handler: (
    operation: 'assets.sign' | 'assets.complete',
    input: unknown,
    signal: AbortSignal | undefined
  ) => Promise<OperationResult<unknown, string>>
): OperationClient<SignedContract> {
  return {
    call: ((
      operation: 'assets.sign' | 'assets.complete',
      input: unknown,
      options?: { signal?: AbortSignal }
    ) => handler(operation, input, options?.signal)) as OperationClient<SignedContract>['call'],
  };
}

function successfulClient(
  calls: Array<{ operation: string; input: unknown; signal?: AbortSignal }> = []
) {
  return clientFrom(async (operation, input, signal) => {
    calls.push({ operation, input, signal });
    return operation === 'assets.sign' ? signSuccess : completionSuccess;
  });
}

function file(contents = 'image', type = 'image/png'): File {
  return new File([contents], 'asset.png', { type });
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
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }

  respond(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.statusText = status >= 200 && status < 300 ? 'OK' : 'Rejected';
    Object.assign(this.responseHeaders, headers);
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

beforeEach(() => {
  MockXhr.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createOperationSignedUpload', () => {
  it('runs sign, isolated provider transfer, and completion without retaining the signed URL', async () => {
    const calls: Array<{ operation: string; input: unknown; signal?: AbortSignal }> = [];
    const upload = createOperationSignedUpload(successfulClient(calls), binding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
    });

    expect(upload.status()).toBe('idle');
    const pending = upload.start(file());
    expect(upload.status()).toBe('signing');
    await waitForXhr();
    expect(upload.status()).toBe('uploading');
    const xhr = lastXhr();
    expect(xhr).toMatchObject({
      method: 'PUT',
      url: 'https://storage.example.test/object-1?signature=secret',
      withCredentials: false,
    });
    expect(xhr.getRequestHeader('content-type')).toBe('image/png');
    expect(xhr.getRequestHeader('x-provider-signature')).toBe('provider-secret');
    expect(xhr.getRequestHeader('authorization')).toBeUndefined();
    expect(xhr.body).toBeInstanceOf(File);
    xhr.progress(5, 10);
    expect(upload.progress()).toBe(0.5);
    xhr.respond(200, { etag: 'provider-etag', 'x-request-id': 'provider-request' });

    const result = await pending;

    expect(result).toMatchObject({
      ok: true,
      provider: { status: 200, headers: { etag: 'provider-etag' } },
      completion: { ok: true, data: { assetId: 'asset-1' } },
    });
    expect(calls.map(call => call.operation)).toEqual(['assets.sign', 'assets.complete']);
    expect(calls[0]?.input).toEqual({
      body: { name: 'asset.png', size: 5, type: 'image/png' },
    });
    expect(calls[1]?.input).toEqual({
      body: { objectKey: 'object-1', providerStatus: 200 },
    });
    expect(calls.every(call => call.signal instanceof AbortSignal)).toBe(true);
    expect(upload.status()).toBe('complete');
    expect(upload.progress()).toBe(1);
    expect(upload.pending()).toBe(false);
    expect(upload.error()).toBeUndefined();
    expect(JSON.stringify(upload.result())).not.toContain('signature=secret');
    expect(JSON.stringify(upload.result())).not.toContain('provider-secret');
  });

  it('returns an expected sign failure without contacting the provider', async () => {
    const signFailure = {
      ok: false,
      status: 403,
      error: { declared: true, code: 'SIGNING_DENIED', message: 'Denied' },
      headers: EMPTY_RESPONSE_METADATA,
    } as const;
    const upload = createOperationSignedUpload(
      clientFrom(async () => signFailure),
      binding,
      { allowedProviderOrigins: ['https://storage.example.test'], createXhr }
    );

    await expect(upload.start(file())).resolves.toMatchObject({
      ok: false,
      stage: 'sign',
      result: { status: 403, error: { code: 'SIGNING_DENIED' } },
    });
    expect(upload.status()).toBe('failure');
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('returns an expected completion failure after successful provider transfer', async () => {
    const completeFailure = {
      ok: false,
      status: 409,
      error: { declared: true, code: 'COMPLETION_REJECTED', message: 'Rejected' },
      headers: EMPTY_RESPONSE_METADATA,
    } as const;
    const upload = createOperationSignedUpload(
      clientFrom(async operation => (operation === 'assets.sign' ? signSuccess : completeFailure)),
      binding,
      { allowedProviderOrigins: ['https://storage.example.test'], createXhr }
    );
    const pending = upload.start(file());
    await waitForXhr();
    lastXhr().respond(200);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      stage: 'complete',
      result: { status: 409, error: { code: 'COMPLETION_REJECTED' } },
    });
    expect(upload.status()).toBe('failure');
    expect(upload.progress()).toBe(1);
  });

  it('surfaces provider rejection and network failure without retaining signed secrets', async () => {
    const rejected = createOperationSignedUpload(successfulClient(), binding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
    });
    const provider = rejected.start(file());
    await waitForXhr();
    lastXhr().respond(503, { 'retry-after': '2' });
    const providerError = await provider.catch(error => error);
    expect(providerError).toBeInstanceOf(SignedUploadProviderError);
    expect(providerError).toMatchObject({ status: 503, headers: { retryAfterMs: 2_000 } });
    expect(JSON.stringify(providerError)).not.toContain('signature=secret');

    const network = rejected.start(file());
    await waitForXhr(2);
    lastXhr().failNetwork();
    await expect(network).rejects.toBeInstanceOf(TransportError);
  });

  it('requires exact absolute provider origins and blocks redirects to another origin', async () => {
    expect(() =>
      createOperationSignedUpload(successfulClient(), binding, {
        allowedProviderOrigins: [],
        createXhr,
      })
    ).toThrow(OperationPolicyError);
    expect(() =>
      createOperationSignedUpload(successfulClient(), binding, {
        allowedProviderOrigins: ['/relative'],
        createXhr,
      })
    ).toThrow(OperationPolicyError);

    const blocked = createOperationSignedUpload(successfulClient(), binding, {
      allowedProviderOrigins: ['https://other.example.test'],
      createXhr,
    });
    await expect(blocked.start(file())).rejects.toMatchObject({
      name: 'OperationPolicyError',
      reason: 'target-origin',
    });
    expect(MockXhr.instances).toHaveLength(0);

    const relativeBinding = {
      ...binding,
      sign: { ...binding.sign, destination: () => ({ url: '/provider' }) },
    } satisfies OperationSignedUploadBinding<SignedContract, 'assets.sign', 'assets.complete'>;
    const relative = createOperationSignedUpload(successfulClient(), relativeBinding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
    });
    await expect(relative.start(file())).rejects.toMatchObject({ reason: 'target-origin' });
  });

  it('validates browser file constraints before signing', async () => {
    const call = vi.fn(async () => signSuccess);
    const upload = createOperationSignedUpload(
      { call: call as OperationClient<SignedContract>['call'] },
      binding,
      { allowedProviderOrigins: ['https://storage.example.test'], createXhr }
    );

    const rejection = await upload
      .start(file('this is too large', 'text/plain'))
      .catch(error => error);

    expect(rejection).toBeInstanceOf(OperationUploadValidationError);
    expect(rejection.issues).toHaveLength(2);
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects cached sign and completion results', async () => {
    const notModified = {
      ok: true,
      notModified: true,
      status: 304,
      headers: EMPTY_RESPONSE_METADATA,
    } as const;
    const cachedSign = createOperationSignedUpload(
      clientFrom(async () => notModified),
      binding,
      { allowedProviderOrigins: ['https://storage.example.test'], createXhr }
    );
    await expect(cachedSign.start(file())).rejects.toMatchObject({
      reason: 'unexpected-status',
      status: 304,
    });

    const cachedComplete = createOperationSignedUpload(
      clientFrom(async operation => (operation === 'assets.sign' ? signSuccess : notModified)),
      binding,
      { allowedProviderOrigins: ['https://storage.example.test'], createXhr }
    );
    const pending = cachedComplete.start(file());
    await waitForXhr();
    lastXhr().respond(200);
    await expect(pending).rejects.toMatchObject({ reason: 'unexpected-status', status: 304 });
  });

  it('contains sign, destination, and completion serializer failures as protocol errors', async () => {
    const signBinding = {
      ...binding,
      sign: {
        ...binding.sign,
        input: () => {
          throw new Error('sign private');
        },
      },
    } satisfies OperationSignedUploadBinding<SignedContract, 'assets.sign', 'assets.complete'>;
    const sign = createOperationSignedUpload(successfulClient(), signBinding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
    });
    await expect(sign.start(file())).rejects.toMatchObject({ reason: 'invalid-envelope' });

    const destinationBinding = {
      ...binding,
      sign: {
        ...binding.sign,
        destination: () => {
          throw new Error('destination private');
        },
      },
    } satisfies OperationSignedUploadBinding<SignedContract, 'assets.sign', 'assets.complete'>;
    const destination = createOperationSignedUpload(successfulClient(), destinationBinding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
    });
    await expect(destination.start(file())).rejects.toMatchObject({ reason: 'invalid-envelope' });

    const completionBinding = {
      ...binding,
      completion: {
        operation: 'assets.complete' as const,
        input: () => {
          throw new Error('completion private');
        },
      },
    } satisfies OperationSignedUploadBinding<SignedContract, 'assets.sign', 'assets.complete'>;
    const completion = createOperationSignedUpload(successfulClient(), completionBinding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
    });
    const pending = completion.start(file());
    await waitForXhr();
    lastXhr().respond(200);
    await expect(pending).rejects.toMatchObject({ reason: 'invalid-envelope' });
  });

  it('cancels during signing, transfer, or an overall timeout without stale revival', async () => {
    let resolveSign!: (value: typeof signSuccess) => void;
    const signing = new Promise<typeof signSuccess>(resolve => {
      resolveSign = resolve;
    });
    const duringSign = createOperationSignedUpload(
      clientFrom(async () => signing),
      binding,
      {
        allowedProviderOrigins: ['https://storage.example.test'],
        createXhr,
      }
    );
    const signPending = duringSign.start(file());
    const signAssertion = expect(signPending).rejects.toBeInstanceOf(OperationAbortedError);
    expect(duringSign.cancel()).toBe(true);
    resolveSign(signSuccess);
    await signAssertion;
    expect(duringSign.status()).toBe('aborted');
    expect(MockXhr.instances).toHaveLength(0);

    const duringTransfer = createOperationSignedUpload(successfulClient(), binding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
    });
    const transferPending = duringTransfer.start(file());
    const transferAssertion = expect(transferPending).rejects.toBeInstanceOf(OperationAbortedError);
    await waitForXhr();
    expect(duringTransfer.cancel()).toBe(true);
    await transferAssertion;
    expect(lastXhr().aborted).toBe(true);
    expect(duringTransfer.cancel()).toBe(false);

    vi.useFakeTimers();
    const timeout = createOperationSignedUpload(successfulClient(), binding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
      timeoutMs: 10,
    });
    const timed = timeout.start(file());
    const timeoutAssertion = expect(timed).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await timeoutAssertion;
  });

  it('resets, destroys, supersedes stale work, and preserves client transport errors', async () => {
    const upload = createOperationSignedUpload(successfulClient(), binding, {
      allowedProviderOrigins: ['https://storage.example.test'],
      createXhr,
    });
    const old = upload.start(file());
    const oldAssertion = expect(old).rejects.toBeInstanceOf(OperationAbortedError);
    await waitForXhr();
    const oldXhr = lastXhr();
    upload.reset();
    await oldAssertion;
    expect(upload.status()).toBe('idle');
    oldXhr.progress(10, 10);
    expect(upload.progress()).toBe(0);
    upload.destroy();
    expect(upload.status()).toBe('aborted');

    const unavailable = createOperationSignedUpload(
      clientFrom(async () => {
        throw new TransportError('Unavailable', { reason: 'unavailable' });
      }),
      binding,
      { allowedProviderOrigins: ['https://storage.example.test'], createXhr }
    );
    await expect(unavailable.start(file())).rejects.toMatchObject({
      name: 'TransportError',
      reason: 'unavailable',
    });
    expect(unavailable.error()).toBeInstanceOf(TransportError);
  });
});
