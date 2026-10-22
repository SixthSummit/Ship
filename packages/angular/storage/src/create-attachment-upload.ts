import { computed, type Signal } from '@angular/core';
import type {
  HttpOperationId,
  OperationCallOptions,
  OperationClient,
  OperationFailureOf,
} from '@sixthsummit/ship-angular/operations';
import {
  type CreateOperationSignedUploadOptions,
  createOperationSignedUpload,
  type OperationSignedUploadResult,
  type OperationSignedUploadStatus,
} from '@sixthsummit/ship-angular/upload';
import type { AttachmentUploadPolicy } from './attachment-policy';

/** The operation id `defineStorageModule` mounts for signed upload intents. */
export const STORAGE_CREATE_INTENT_OPERATION_ID = 'ship-storage.create-intent';
/** The operation id `defineStorageModule` mounts for completion. */
export const STORAGE_COMPLETE_OPERATION_ID = 'ship-storage.complete';

export interface StorageIntentData {
  readonly intentId: string;
  readonly objectKey: string;
  readonly upload: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly expiresAt: string;
}

export interface StorageCompletionData {
  readonly objectId: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly size: number;
}

/**
 * The two framework operations an attachment upload drives, as the client
 * contract projects them. A contract that mounts the storage module under
 * other ids passes them explicitly through the binding.
 */
export interface StorageContract {
  readonly [STORAGE_CREATE_INTENT_OPERATION_ID]: {
    readonly input: {
      readonly body: {
        readonly attachment: string;
        readonly contentType: string;
        readonly size: number;
        readonly filename?: string;
      };
    };
    readonly success: { readonly 201: StorageIntentData };
    readonly errors: string;
    readonly transport: 'http';
  };
  readonly [STORAGE_COMPLETE_OPERATION_ID]: {
    readonly input: { readonly params: { readonly intentId: string } };
    readonly success: { readonly 200: StorageCompletionData };
    readonly errors: string;
    readonly transport: 'http';
  };
}

export interface AttachmentUploadBinding {
  /** The declared attachment id, for example `gallery.photo`. */
  readonly attachment: string;
  /** Client-side validation; read it from the manifest with `attachmentPolicyFromManifest`. */
  readonly policy: AttachmentUploadPolicy;
  /** Sent as the intent's `filename`; defaults to the file's own name. */
  readonly filename?: (file: File) => string | undefined;
}

export type AttachmentUploadStatus = OperationSignedUploadStatus;

type IntentIdOf<TContract extends StorageContract> = Extract<
  HttpOperationId<TContract>,
  typeof STORAGE_CREATE_INTENT_OPERATION_ID
>;
type CompleteIdOf<TContract extends StorageContract> = Extract<
  HttpOperationId<TContract>,
  typeof STORAGE_COMPLETE_OPERATION_ID
>;

export type AttachmentUploadResult<TContract extends StorageContract> = OperationSignedUploadResult<
  TContract,
  IntentIdOf<TContract>,
  CompleteIdOf<TContract>
>;

export interface AttachmentUploadCallOptions {
  readonly intent?: OperationCallOptions;
  readonly complete?: OperationCallOptions;
}

export type CreateAttachmentUploadOptions = CreateOperationSignedUploadOptions;

export interface AttachmentUpload<TContract extends StorageContract> {
  readonly status: Signal<AttachmentUploadStatus>;
  readonly pending: Signal<boolean>;
  /** 0..1 of the provider transfer; the intent and completion calls do not move it. */
  readonly progress: Signal<number>;
  readonly result: Signal<AttachmentUploadResult<TContract> | undefined>;
  /** The settled object, ready to attach through the application's own write operation. */
  readonly object: Signal<StorageCompletionData | undefined>;
  readonly error: Signal<Error | undefined>;
  /** The intent the current transfer runs under, for diagnostics; cleared on reset. */
  readonly intent: Signal<StorageIntentData | undefined>;
  start(file: File, options?: AttachmentUploadCallOptions): Promise<AttachmentUploadResult<TContract>>;
  cancel(): boolean;
  reset(): void;
  destroy(): void;
}

/**
 * Drives one managed attachment upload: validate the file against the
 * declared policy, ask `ship-storage.create-intent` for a signed destination,
 * PUT the bytes there with progress, then settle through
 * `ship-storage.complete`. The settled `object` is what the application's own
 * attach operation receives; this client never touches the owning record.
 */
export function createAttachmentUpload<TContract extends StorageContract>(
  client: OperationClient<TContract>,
  binding: AttachmentUploadBinding,
  options: CreateAttachmentUploadOptions
): AttachmentUpload<TContract> {
  let currentIntent: StorageIntentData | undefined;
  const upload = createOperationSignedUpload<TContract, IntentIdOf<TContract>, CompleteIdOf<TContract>>(
    client,
    {
      sign: {
        operation: STORAGE_CREATE_INTENT_OPERATION_ID as IntentIdOf<TContract>,
        input: file =>
          ({
            body: {
              attachment: binding.attachment,
              contentType: file.type,
              size: file.size,
              ...(filenameFor(binding, file) === undefined
                ? {}
                : { filename: filenameFor(binding, file) }),
            },
          }) as never,
        destination: data => {
          const intent = data as StorageIntentData;
          currentIntent = intent;
          return {
            url: intent.upload.url,
            method: intent.upload.method === 'PUT' ? 'PUT' : 'PUT',
            headers: intent.upload.headers,
          };
        },
      },
      file: {
        field: binding.attachment,
        minimumCount: 1,
        maximumCount: 1,
        maximumBytes: binding.policy.maxBytes,
        acceptedMediaTypes: binding.policy.contentTypes,
      },
      // The binding's completion slot is a deferred conditional over the
      // generic contract; StorageContract guarantees the operation exists.
      completion: {
        operation: STORAGE_COMPLETE_OPERATION_ID,
        input: () => {
          if (currentIntent === undefined) {
            throw new Error('attachment completion requested before an intent was issued');
          }
          return { params: { intentId: currentIntent.intentId } };
        },
      } as never,
    },
    options
  );

  const object = computed<StorageCompletionData | undefined>(() => {
    const result = upload.result();
    if (result === undefined || !result.ok) return undefined;
    const completion = result.completion as { readonly data?: unknown } | undefined;
    return completion?.data as StorageCompletionData | undefined;
  });
  const intent = computed<StorageIntentData | undefined>(() =>
    upload.status() === 'idle' ? undefined : currentIntent
  );

  return {
    status: upload.status,
    pending: upload.pending,
    progress: upload.progress,
    result: upload.result as Signal<AttachmentUploadResult<TContract> | undefined>,
    object,
    error: upload.error,
    intent,
    start: (file, callOptions = {}) =>
      upload.start(file, {
        ...(callOptions.intent === undefined ? {} : { sign: callOptions.intent }),
        ...(callOptions.complete === undefined ? {} : { complete: callOptions.complete }),
      }) as Promise<AttachmentUploadResult<TContract>>,
    cancel: () => upload.cancel(),
    reset: () => {
      currentIntent = undefined;
      upload.reset();
    },
    destroy: () => {
      currentIntent = undefined;
      upload.destroy();
    },
  };
}

/** Narrow a failed result to the stage that failed, for template branching. */
export function attachmentUploadFailure<TContract extends StorageContract>(
  result: AttachmentUploadResult<TContract> | undefined
):
  | {
      readonly stage: 'sign' | 'complete';
      readonly result:
        | OperationFailureOf<TContract, IntentIdOf<TContract>>
        | OperationFailureOf<TContract, CompleteIdOf<TContract>>;
    }
  | undefined {
  if (result === undefined || result.ok) return undefined;
  return { stage: result.stage, result: result.result };
}

function filenameFor(binding: AttachmentUploadBinding, file: File): string | undefined {
  if (binding.filename !== undefined) return binding.filename(file);
  return file.name.length > 0 ? file.name : undefined;
}
