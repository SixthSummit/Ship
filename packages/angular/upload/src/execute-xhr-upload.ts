import { OperationAbortedError, TransportError } from '@sixthsummit/ship-angular/operations';

interface XhrUploadRequest {
  readonly url: string;
  readonly method: 'POST' | 'PUT' | 'PATCH';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: XMLHttpRequestBodyInit;
  readonly withCredentials: boolean;
}

interface XhrUploadResponse {
  readonly status: number;
  readonly statusText: string;
  readonly bodyText: string;
  readonly headers: Headers;
}

interface ExecuteXhrUploadOptions {
  readonly signal: AbortSignal;
  readonly createXhr?: () => XMLHttpRequest;
  readonly onCreated?: (xhr: XMLHttpRequest) => void;
  readonly onProgress?: (progress: number) => void;
}

/** Execute one XHR upload attempt while retaining progress and cancellation semantics. */
export function executeXhrUpload(
  request: XhrUploadRequest,
  options: ExecuteXhrUploadOptions
): Promise<XhrUploadResponse> {
  return new Promise((resolve, reject) => {
    let xhr: XMLHttpRequest;
    try {
      xhr = options.createXhr?.() ?? defaultXhr();
    } catch (error: unknown) {
      reject(error);
      return;
    }
    options.onCreated?.(xhr);
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', onSignalAbort);
      callback();
    };
    const onSignalAbort = () => xhr.abort();
    options.signal.addEventListener('abort', onSignalAbort, { once: true });
    xhr.open(request.method, request.url);
    xhr.withCredentials = request.withCredentials;
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(1, Math.max(0, event.loaded / event.total)));
      }
    };
    xhr.upload.onload = () => options.onProgress?.(1);
    xhr.onload = () =>
      settle(() =>
        resolve({
          status: xhr.status,
          statusText: xhr.statusText,
          bodyText: xhr.responseText,
          headers: headersFromXhr(xhr),
        })
      );
    xhr.onerror = () =>
      settle(() =>
        reject(
          new TransportError('The upload transport failed', {
            reason: 'network',
          })
        )
      );
    xhr.onabort = () => settle(() => reject(new OperationAbortedError()));
    try {
      xhr.send(request.body);
    } catch (error: unknown) {
      settle(() => reject(error));
    }
  });
}

function defaultXhr(): XMLHttpRequest {
  if (typeof XMLHttpRequest === 'undefined') {
    throw new TransportError('Upload progress is unavailable in this runtime', {
      reason: 'unavailable',
    });
  }
  return new XMLHttpRequest();
}

function headersFromXhr(xhr: XMLHttpRequest): Headers {
  const headers = new Headers();
  const raw = xhr.getAllResponseHeaders?.() ?? '';
  for (const line of raw.trim().split(/[\r\n]+/)) {
    if (line.length === 0) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  for (const name of [
    'content-type',
    'content-disposition',
    'x-request-id',
    'retry-after',
    'etag',
    'idempotency-key',
    'idempotency-replayed',
    'idempotency-result',
  ]) {
    const value = xhr.getResponseHeader(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}
