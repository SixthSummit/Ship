import { type Signal, signal, type WritableSignal } from '@angular/core';
import { ApiError } from '../errors/ApiError';

/**
 * Status of a {@link ShipUpload}.
 *
 * - `'idle'` — never started; call `start(file)` to upload.
 * - `'uploading'` — request in flight; `progress()` updates as bytes go out.
 * - `'complete'` — server returned a 2xx response; `value()` holds it.
 * - `'error'` — non-2xx response or transport failure; `error()` holds details.
 * - `'aborted'` — explicit `abort()` call.
 */
export type ShipUploadStatus = 'idle' | 'uploading' | 'complete' | 'error' | 'aborted';

/**
 * Reactive upload primitive returned by {@link createUpload}.
 */
export interface ShipUpload<TResponse = unknown> {
  /** The parsed server response, or `undefined` until completion. */
  readonly value: Signal<TResponse | undefined>;
  /**
   * Upload progress in the range `[0, 1]`. `0` while connecting; `1` once
   * all bytes have been ack'd. Updates on every `progress` XHR event.
   *
   * Note: only a transmit-side progress is tracked. Server-side processing
   * time after the upload finishes is reflected by the `'uploading'` →
   * `'complete'` status transition, not an additional progress signal.
   */
  readonly progress: Signal<number>;
  /** Current status. */
  readonly status: Signal<ShipUploadStatus>;
  /** Error from the most recent failed attempt, or `undefined`. */
  readonly error: Signal<unknown>;
  /** Begin the upload of `file`. Calling again on an in-flight upload is a no-op. */
  start(file: File): void;
  /** Abort the in-flight upload. No-op when complete / errored. */
  abort(): void;
  /** Reset to idle (drops any prior result). */
  reset(): void;
}

export interface CreateUploadOptions<TResponse = unknown> {
  /** Form field name. Default: `'file'`. */
  field?: string;
  /** HTTP method. Default: `'POST'`. */
  method?: 'POST' | 'PUT' | 'PATCH';
  /** Additional headers (Content-Type is set by the browser for multipart). */
  headers?: Record<string, string>;
  /** Additional FormData fields to send alongside the file. */
  fields?: Record<string, string | Blob>;
  /** Forward credentials (cookies). Default: `false`. */
  withCredentials?: boolean;
  /** Optional client-side max bytes — `start(file)` rejects locally before XHR. */
  maxBytes?: number;
  /** Optional client-side MIME allowlist (matches `File.type`). */
  accept?: readonly string[];
  /** Parse the XHR response. Default: `JSON.parse` (or raw text). */
  parseResponse?: (xhr: XMLHttpRequest) => TResponse;
}

const defaultParse = <TResponse>(xhr: XMLHttpRequest): TResponse => {
  const ct = xhr.getResponseHeader('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(xhr.responseText) as TResponse;
    } catch {
      return xhr.responseText as unknown as TResponse;
    }
  }
  return xhr.responseText as unknown as TResponse;
};

/**
 * Create a reactive file upload primitive aligned with ShipAPI's
 * `parseUpload` + `fileSchema`. Uses `XMLHttpRequest` (rather than `fetch`)
 * to surface upload progress events, which `fetch` doesn't expose.
 *
 * @example Avatar upload against ShipAPI
 * ```ts
 * import { createUpload } from '@sixthsummit/ship-angular';
 *
 * @Component({...})
 * export class AvatarComponent {
 *   readonly upload = createUpload<{ url: string }>(
 *     () => '/api/users/avatar',
 *     { accept: ['image/png', 'image/jpeg'], maxBytes: 5 * 1024 * 1024 }
 *   );
 *
 *   onFileSelected(file: File) {
 *     this.upload.start(file);
 *   }
 * }
 * // template: progress bar bound to `upload.progress()` (0..1)
 * ```
 *
 * Auth: the auth interceptor does NOT apply to XHR. Apps that need
 * Bearer tokens on uploads should pass them via `headers` (read from
 * `inject(AuthService).idToken()`), or use a fetch-wrapper-aware variant
 * once the backend supports streaming uploads via `fetch`.
 *
 * Validation: `maxBytes` and `accept` are enforced client-side **before**
 * the XHR opens — server-side `fileSchema` is the source of truth, but
 * the client gate avoids sending megabytes the server will reject.
 *
 * Must be called inside an injection context.
 */
export function createUpload<TResponse = unknown>(
  url: string | (() => string),
  options: CreateUploadOptions<TResponse> = {}
): ShipUpload<TResponse> {
  const value = signal<TResponse | undefined>(undefined);
  const progress = signal(0);
  const status: WritableSignal<ShipUploadStatus> = signal('idle');
  const error = signal<unknown>(undefined);
  let xhr: XMLHttpRequest | undefined;

  const reset = () => {
    xhr = undefined;
    value.set(undefined);
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
    if (options.maxBytes !== undefined && file.size > options.maxBytes) {
      error.set(
        new Error(`createUpload: file exceeds maxBytes (${file.size} > ${options.maxBytes})`)
      );
      status.set('error');
      return;
    }
    if (options.accept && options.accept.length > 0 && !options.accept.includes(file.type)) {
      error.set(
        new Error(
          `createUpload: file type "${file.type}" not allowed (accept: ${options.accept.join(', ')})`
        )
      );
      status.set('error');
      return;
    }

    const targetUrl = typeof url === 'function' ? url() : url;
    const formData = new FormData();
    formData.append(options.field ?? 'file', file, file.name);
    if (options.fields) {
      for (const [k, v] of Object.entries(options.fields)) {
        formData.append(k, v);
      }
    }

    const x = new XMLHttpRequest();
    xhr = x;
    value.set(undefined);
    error.set(undefined);
    progress.set(0);
    status.set('uploading');

    x.open(options.method ?? 'POST', targetUrl);
    if (options.withCredentials) x.withCredentials = true;
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
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
        const parser =
          options.parseResponse ?? (defaultParse as (xhr: XMLHttpRequest) => TResponse);
        try {
          value.set(parser(x));
        } catch (e) {
          error.set(e);
          status.set('error');
          return;
        }
        status.set('complete');
      } else {
        error.set(buildXhrError(x));
        status.set('error');
      }
    };
    x.onerror = () => {
      error.set(new Error('createUpload: network error'));
      status.set('error');
    };
    x.onabort = () => {
      // status is set by abort() — guard avoids races
      if (status() !== 'aborted') status.set('aborted');
    };

    x.send(formData);
  };

  return {
    value: value.asReadonly(),
    progress: progress.asReadonly(),
    status: status.asReadonly(),
    error: error.asReadonly(),
    start,
    abort,
    reset,
  };
}

function buildXhrError(xhr: XMLHttpRequest): unknown {
  // Try to parse a ShipAPI envelope from responseText; fall back to a
  // synthetic ApiError so consumers can switch on `.code` uniformly.
  const ct = xhr.getResponseHeader('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const body = JSON.parse(xhr.responseText) as unknown;
      if (ApiError.isEnvelope(body)) {
        return ApiError.fromEnvelope(body, xhr.status);
      }
    } catch {
      // fall through
    }
  }
  return ApiError.fromEnvelope(
    {
      success: false,
      error: {
        code: xhr.status >= 500 ? 'INTERNAL_SERVER_ERROR' : `HTTP_${xhr.status}`,
        message: xhr.statusText || `HTTP ${xhr.status}`,
      },
    },
    xhr.status
  );
}
