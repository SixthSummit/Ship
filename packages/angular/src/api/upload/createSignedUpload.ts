import { type Signal, signal, type WritableSignal } from '@angular/core';
import type { ShipUpload, ShipUploadStatus } from './createUpload';

/**
 * Configuration for {@link createSignedUpload}.
 */
export interface CreateSignedUploadOptions {
  /**
   * Sign-request thunk. Returns the destination URL the client should
   * PUT to, plus optional headers the storage backend requires.
   *
   * Typical implementation: a Hono `hc()` call to a `/signed-url`
   * endpoint that wraps ShipAPI's `signedUrl(key, opts)`.
   *
   * @param file - The file the user picked. Use `file.size`, `file.type`,
   *   `file.name` to inform the signing request.
   */
  signRequest: (file: File) => Promise<SignedUrlResponse>;
  /**
   * HTTP method for the storage upload. Default: `'PUT'` (matches S3 /
   * GCS signed-URL convention).
   */
  method?: 'PUT' | 'POST';
  /**
   * Forward credentials on the upload request. Default: `false` —
   * signed URLs are pre-authorised; cookies usually shouldn't go to
   * storage.
   */
  withCredentials?: boolean;
}

/**
 * Sign-request response shape. Includes the URL to upload to and any
 * extra headers the storage backend needs.
 */
export interface SignedUrlResponse {
  /** The signed URL to PUT (or POST) the raw file to. */
  url: string;
  /**
   * Headers that must be on the upload request to satisfy the signature.
   * Typically `{ 'Content-Type': '<file.type>' }` for S3, sometimes
   * additional `x-goog-*` for GCS.
   */
  headers?: Record<string, string>;
}

/**
 * Reactive direct-to-storage upload primitive (two-step: sign → PUT).
 *
 * Pairs with ShipAPI's storage adapter pattern (`signedUrl(key, opts)`):
 * the backend issues a signed URL via `hc()`, the browser PUTs the raw
 * file directly to S3/GCS without going through the API server. Avoids
 * the egress + memory cost of relaying large files through the API.
 *
 * Two-step lifecycle:
 *
 * 1. **Signing.** `start(file)` calls `signRequest(file)` to mint the
 *    signed URL. Status: `'uploading'` (we don't expose a `'signing'`
 *    intermediate — apps that need it can read `progress() === 0`).
 * 2. **PUT.** Direct upload to the signed URL with progress events.
 *    Status: `'complete'` on 2xx.
 *
 * Surface mirrors {@link ShipUpload} but `value()` is `void` (the
 * caller already knows the storage URL — they passed it via
 * `signRequest`'s response).
 */
export interface ShipSignedUpload extends Omit<ShipUpload<void>, 'value'> {
  /** The signed URL the file was uploaded to, set after step 1. */
  readonly destinationUrl: Signal<string | undefined>;
}

/**
 * Two-step direct-to-storage upload using a backend-issued signed URL.
 *
 * @example Direct-to-S3 avatar upload
 * ```ts
 * import { createSignedUpload } from '@sixthsummit/ship-angular';
 * import { api } from '@/api'; // hc<ShipApiClient>()
 *
 * const upload = createSignedUpload({
 *   signRequest: async (file) => {
 *     const res = await api.storage.signedUrl.$post({
 *       json: { key: `avatars/${userId}/${file.name}`, contentType: file.type },
 *     });
 *     return res.json();
 *   },
 * });
 *
 * upload.start(file);
 * // upload.progress(): 0..1
 * // upload.status() === 'complete' → upload.destinationUrl() is the storage URL
 * ```
 */
export function createSignedUpload(options: CreateSignedUploadOptions): ShipSignedUpload {
  const destinationUrl = signal<string | undefined>(undefined);
  const progress = signal(0);
  const status: WritableSignal<ShipUploadStatus> = signal('idle');
  const error = signal<unknown>(undefined);
  let xhr: XMLHttpRequest | undefined;

  const reset = () => {
    xhr = undefined;
    destinationUrl.set(undefined);
    progress.set(0);
    error.set(undefined);
    status.set('idle');
  };

  const abort = () => {
    if (status() === 'complete' || status() === 'error') return;
    xhr?.abort();
    status.set('aborted');
  };

  const start = (file: File) => {
    if (status() === 'uploading') return;
    destinationUrl.set(undefined);
    error.set(undefined);
    progress.set(0);
    status.set('uploading');

    options
      .signRequest(file)
      .then(signed => {
        if (status() !== 'uploading') return; // aborted during signing
        destinationUrl.set(signed.url);

        const x = new XMLHttpRequest();
        xhr = x;
        x.open(options.method ?? 'PUT', signed.url);
        if (options.withCredentials) x.withCredentials = true;
        if (signed.headers) {
          for (const [k, v] of Object.entries(signed.headers)) {
            x.setRequestHeader(k, v);
          }
        }
        x.upload.onprogress = ev => {
          if (ev.lengthComputable && ev.total > 0) {
            progress.set(ev.loaded / ev.total);
          }
        };
        x.upload.onload = () => progress.set(1);
        x.onload = () => {
          if (x.status >= 200 && x.status < 300) {
            status.set('complete');
          } else {
            error.set(new Error(`createSignedUpload: storage rejected upload (HTTP ${x.status})`));
            status.set('error');
          }
        };
        x.onerror = () => {
          error.set(new Error('createSignedUpload: network error during PUT'));
          status.set('error');
        };
        x.onabort = () => {
          if (status() !== 'aborted') status.set('aborted');
        };
        x.send(file);
      })
      .catch((e: unknown) => {
        if (status() === 'aborted') return; // signing aborted
        error.set(e);
        status.set('error');
      });
  };

  return {
    destinationUrl: destinationUrl.asReadonly(),
    progress: progress.asReadonly(),
    status: status.asReadonly(),
    error: error.asReadonly(),
    start,
    abort,
    reset,
  };
}
