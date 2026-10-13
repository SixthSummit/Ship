import { HttpErrorResponse, type HttpHeaders } from '@angular/common/http';

/** Lossless, credential-safe failure surfaced by the generic REST ApiClient. */
export class HttpRequestError extends Error {
  readonly name = 'HttpRequestError';
  readonly status: number;
  readonly statusText: string;
  readonly responseBody: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestId?: string;
  readonly code?: string;
  readonly details?: unknown;

  private constructor(error: HttpErrorResponse) {
    const body = asRecord(error.error);
    const nestedError = asRecord(body?.['error']);
    const message =
      stringValue(nestedError?.['message']) ??
      stringValue(body?.['message']) ??
      error.message ??
      `HTTP ${error.status}`;
    super(message);

    this.status = error.status;
    this.statusText = error.statusText;
    this.responseBody = error.error;
    this.headers = headersToRecord(error.headers);
    const requestId =
      error.headers.get('x-request-id') ??
      stringValue(nestedError?.['requestId']) ??
      stringValue(body?.['requestId']);
    if (requestId !== undefined) this.requestId = requestId;
    const code = stringValue(nestedError?.['code']) ?? stringValue(body?.['code']);
    if (code !== undefined) this.code = code;
    const details = nestedError?.['details'] ?? body?.['details'];
    if (details !== undefined) this.details = details;
  }

  static fromHttpErrorResponse(error: HttpErrorResponse): HttpRequestError {
    return new HttpRequestError(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function headersToRecord(headers: HttpHeaders): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(headers.keys().map(name => [name.toLowerCase(), headers.get(name) ?? '']))
  );
}
