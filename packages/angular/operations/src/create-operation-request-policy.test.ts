import { describe, expect, it, vi } from 'vitest';
import { createOperationRequestPolicy } from './create-operation-request-policy';
import type { OperationPolicyMap } from './operation-policy';

interface TestContract {
  readonly 'files.upload': {
    readonly input: { readonly files: { readonly document: File } };
    readonly success: { readonly 201: { readonly id: string } };
    readonly errors: 'UPLOAD_FAILED';
    readonly transport: 'upload';
  };
  readonly 'public.stream': {
    readonly input: Record<string, never>;
    readonly success: { readonly 200: never };
    readonly errors: 'UNAVAILABLE';
    readonly transport: 'stream';
  };
}

const policies: OperationPolicyMap<TestContract> = {
  'files.upload': {
    authentication: 'required',
    safety: 'unsafe',
    idempotency: 'supported',
    replayable: false,
    refreshAuthentication: true,
  },
  'public.stream': {
    authentication: 'anonymous',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
};

describe('shared operation request policy', () => {
  it('prepares stable policy headers and fresh credentials for any transport', async () => {
    const getToken = vi.fn(async ({ attempt }: { attempt: number }) => `token-${attempt}`);
    const generate = vi.fn(() => 'request-1');
    const policy = createOperationRequestPolicy<TestContract>({
      policies,
      credentials: { kind: 'bearer', getToken },
      baseHeaders: { 'X-Locale': 'en-CA' },
      requestId: { generate },
      allowedOrigins: ['https://api.example.test'],
      baseOrigin: 'https://api.example.test',
    });
    const call = policy.begin('files.upload', {
      idempotencyKey: 'upload-1',
      headers: { 'X-Feature': 'documents' },
      timeoutMs: 5_000,
      keepalive: true,
    });
    const signal = new AbortController().signal;

    const first = await call.prepare({ attempt: 1, signal, targetUrl: '/v1/files' });
    const second = await call.prepare({
      attempt: 2,
      signal,
      targetUrl: 'https://api.example.test/v1/files',
    });

    expect(first).toMatchObject({
      attempt: 1,
      credentials: 'omit',
      idempotencyKey: 'upload-1',
      timeoutMs: 5_000,
      keepalive: true,
      headers: {
        authorization: 'Bearer token-1',
        'idempotency-key': 'upload-1',
        'x-request-id': 'request-1',
        'x-locale': 'en-CA',
        'x-feature': 'documents',
      },
    });
    expect(second.headers?.['authorization']).toBe('Bearer token-2');
    expect(second.keepalive).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('rejects missing, invalid, and unapproved targets before credential access', async () => {
    const getToken = vi.fn(async () => 'secret-token');
    const policy = createOperationRequestPolicy<TestContract>({
      policies,
      credentials: { kind: 'bearer', getToken },
      allowedOrigins: ['https://api.example.test'],
    });
    const call = policy.begin('files.upload');
    const attempt = { attempt: 1, signal: new AbortController().signal };

    await expect(call.prepare(attempt)).rejects.toMatchObject({ reason: 'target-origin' });
    await expect(call.prepare({ ...attempt, targetUrl: 'not a url' })).rejects.toMatchObject({
      reason: 'target-origin',
    });
    await expect(
      call.prepare({ ...attempt, targetUrl: 'https://evil.example.test/steal' })
    ).rejects.toMatchObject({ reason: 'target-origin' });
    expect(getToken).not.toHaveBeenCalled();
  });

  it('rejects malformed allowed-origin configuration immediately', () => {
    expect(() =>
      createOperationRequestPolicy<TestContract>({ policies, allowedOrigins: ['relative/path'] })
    ).toThrow(expect.objectContaining({ reason: 'target-origin' }));
  });

  it('strips inherited credentials from anonymous capabilities', async () => {
    const getToken = vi.fn(async () => 'secret-token');
    const policy = createOperationRequestPolicy<TestContract>({
      policies,
      credentials: { kind: 'bearer', getToken },
      baseHeaders: {
        Authorization: 'Bearer inherited',
        Cookie: 'session=secret',
        'X-Csrf-Token': 'csrf-secret',
      },
    });

    const prepared = await policy
      .begin('public.stream')
      .prepare({ attempt: 1, signal: new AbortController().signal });

    expect(prepared.credentials).toBe('omit');
    expect(prepared.headers).not.toHaveProperty('authorization');
    expect(prepared.headers).not.toHaveProperty('cookie');
    expect(prepared.headers).not.toHaveProperty('x-csrf-token');
    expect(getToken).not.toHaveBeenCalled();
  });

  it('coordinates one explicit refresh per logical transport call', async () => {
    const refresh = vi.fn(async () => undefined);
    const policy = createOperationRequestPolicy<TestContract>({
      policies,
      credentials: { kind: 'bearer', getToken: async () => 'token', refresh },
    });
    const call = policy.begin('files.upload');
    const signal = new AbortController().signal;

    await expect(call.refreshAuthentication(401, 1, signal)).resolves.toBe(true);
    await expect(call.refreshAuthentication(401, 2, signal)).resolves.toBe(false);
    await expect(call.refreshAuthentication(403, 3, signal)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
