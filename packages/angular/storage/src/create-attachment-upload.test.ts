import {
  EMPTY_RESPONSE_METADATA,
  type OperationClient,
  type OperationResult,
} from '@sixthsummit/ship-angular/operations';
import { OperationUploadValidationError } from '@sixthsummit/ship-angular/upload';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentPolicyError, attachmentPolicyFromManifest } from './attachment-policy';
import {
  attachmentUploadFailure,
  createAttachmentUpload,
  type StorageContract,
} from './create-attachment-upload';

type Contract = StorageContract;

const manifest = {
  attachments: {
    'gallery.photo': {
      cardinality: 'many' as const,
      contentTypes: ['image/png', 'image/jpeg'],
      maxBytes: 12,
      visibility: 'private' as const,
      maxCount: 12,
      variants: ['thumb'],
    },
  },
};

const intentSuccess = {
  ok: true,
  status: 201,
  data: {
    intentId: 'intent-1',
    objectKey: 'gallery.photo/intent-1',
    upload: {
      url: 'https://storage.example.test/upload/gallery.photo/intent-1?sig=secret',
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
    },
    expiresAt: '2026-10-22T10:15:00.000Z',
  },
  headers: EMPTY_RESPONSE_METADATA,
} as const;

const completionSuccess = {
  ok: true,
  status: 200,
  data: { objectId: 'object-1', objectKey: 'gallery.photo/intent-1', contentType: 'image/png', size: 5 },
  headers: EMPTY_RESPONSE_METADATA,
} as const;

interface Call {
  readonly operation: string;
  readonly input: unknown;
}

function clientFrom(
  handler: (operation: string, input: unknown) => Promise<OperationResult<unknown, string>>
): OperationClient<Contract> {
  return {
    call: ((operation: string, input: unknown) => handler(operation, input)) as OperationClient<Contract>['call'],
  };
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
  readonly headers: Record<string, string> = {};
  constructor() {
    MockXhr.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  getAllResponseHeaders(): string {
    return '';
  }
  getResponseHeader(): string | null {
    return null;
  }
  send(): void {}
  abort(): void {
    this.onabort?.();
  }
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  respond(status: number): void {
    this.status = status;
    this.statusText = status < 300 ? 'OK' : 'Rejected';
    this.onload?.();
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
  vi.restoreAllMocks();
});

describe('attachmentPolicyFromManifest', () => {
  it('reads the declared policy and refuses unknown attachments', () => {
    expect(attachmentPolicyFromManifest(manifest, 'gallery.photo')).toEqual({
      contentTypes: ['image/png', 'image/jpeg'],
      maxBytes: 12,
      cardinality: 'many',
      maxCount: 12,
    });
    expect(() => attachmentPolicyFromManifest(manifest, 'gallery.nope')).toThrow(AttachmentPolicyError);
    expect(() => attachmentPolicyFromManifest({}, 'gallery.photo')).toThrow(
      'declares no attachment "gallery.photo"'
    );
  });
});

describe('createAttachmentUpload', () => {
  const binding = {
    attachment: 'gallery.photo',
    policy: attachmentPolicyFromManifest(manifest, 'gallery.photo'),
  };
  const options = { allowedProviderOrigins: ['https://storage.example.test'], createXhr };

  it('validates against the declared policy before any call', async () => {
    const calls: Call[] = [];
    const upload = createAttachmentUpload(
      clientFrom(async (operation, input) => {
        calls.push({ operation, input });
        return intentSuccess;
      }),
      binding,
      options
    );
    await expect(upload.start(new File(['x'], 'note.txt', { type: 'text/plain' }))).rejects.toBeInstanceOf(
      OperationUploadValidationError
    );
    await expect(
      upload.start(new File(['0123456789abcdef'], 'big.png', { type: 'image/png' }))
    ).rejects.toBeInstanceOf(OperationUploadValidationError);
    expect(calls).toEqual([]);
    expect(upload.status()).toBe('error');
    expect(upload.object()).toBeUndefined();
  });

  it('asks for an intent, transfers with progress and settles the object', async () => {
    const calls: Call[] = [];
    const upload = createAttachmentUpload(
      clientFrom(async (operation, input) => {
        calls.push({ operation, input });
        return operation === 'ship-storage.create-intent' ? intentSuccess : completionSuccess;
      }),
      binding,
      options
    );
    const file = new File(['hello'], 'photo.png', { type: 'image/png' });
    const pending = upload.start(file);
    await waitForXhr();
    expect(upload.status()).toBe('uploading');
    expect(upload.intent()?.intentId).toBe('intent-1');
    expect(lastXhr().method).toBe('PUT');
    expect(lastXhr().url).toBe(intentSuccess.data.upload.url);
    expect(lastXhr().headers['content-type']).toBe('image/png');
    lastXhr().progress(2, 5);
    expect(upload.progress()).toBeCloseTo(0.4);
    lastXhr().respond(200);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(upload.status()).toBe('complete');
    expect(upload.object()).toEqual(completionSuccess.data);
    expect(calls).toEqual([
      {
        operation: 'ship-storage.create-intent',
        input: {
          body: { attachment: 'gallery.photo', contentType: 'image/png', size: 5, filename: 'photo.png' },
        },
      },
      { operation: 'ship-storage.complete', input: { params: { intentId: 'intent-1' } } },
    ]);
    expect(attachmentUploadFailure(result)).toBeUndefined();
    upload.reset();
    expect(upload.intent()).toBeUndefined();
    expect(upload.status()).toBe('idle');
  });

  it('surfaces declared failures from either stage', async () => {
    const rejected = {
      ok: false,
      status: 413,
      error: { code: 'ATTACHMENT_TOO_LARGE', message: 'too large' },
      headers: EMPTY_RESPONSE_METADATA,
    } as const;
    const upload = createAttachmentUpload(clientFrom(async () => rejected), binding, options);
    const result = await upload.start(new File(['hello'], 'photo.png', { type: 'image/png' }));
    expect(result).toMatchObject({ ok: false, stage: 'sign' });
    expect(attachmentUploadFailure(result)).toMatchObject({
      stage: 'sign',
      result: { error: { code: 'ATTACHMENT_TOO_LARGE' } },
    });
    expect(upload.status()).toBe('failure');

    const expired = {
      ok: false,
      status: 410,
      error: { code: 'INTENT_EXPIRED', message: 'expired' },
      headers: EMPTY_RESPONSE_METADATA,
    } as const;
    const late = createAttachmentUpload(
      clientFrom(async operation =>
        operation === 'ship-storage.create-intent' ? intentSuccess : expired
      ),
      binding,
      options
    );
    const pending = late.start(new File(['hello'], 'photo.png', { type: 'image/png' }));
    await waitForXhr(1);
    lastXhr().respond(200);
    expect(await pending).toMatchObject({ ok: false, stage: 'complete' });
    expect(late.object()).toBeUndefined();
  });

  it('refuses a signed destination outside the allowed provider origins', async () => {
    const elsewhere = {
      ...intentSuccess,
      data: {
        ...intentSuccess.data,
        upload: { ...intentSuccess.data.upload, url: 'https://evil.example.test/upload' },
      },
    };
    const upload = createAttachmentUpload(clientFrom(async () => elsewhere), binding, options);
    await expect(upload.start(new File(['hello'], 'photo.png', { type: 'image/png' }))).rejects.toThrow();
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('cancels an in-flight transfer and never completes it', async () => {
    const calls: Call[] = [];
    const upload = createAttachmentUpload(
      clientFrom(async (operation, input) => {
        calls.push({ operation, input });
        return intentSuccess;
      }),
      { ...binding, filename: () => undefined },
      options
    );
    const pending = upload.start(new File(['hello'], 'photo.png', { type: 'image/png' }));
    await waitForXhr();
    expect(upload.cancel()).toBe(true);
    await expect(pending).rejects.toThrow();
    expect(upload.status()).toBe('aborted');
    expect(calls.map(call => call.operation)).toEqual(['ship-storage.create-intent']);
    expect((calls[0]?.input as { body: { filename?: string } }).body.filename).toBeUndefined();
    upload.destroy();
  });
});
