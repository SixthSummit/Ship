import { describe, expect, it } from 'vitest';
import { OperationApiError } from './operation-api-error';
import { ProtocolError } from './protocol-error';
import {
  parseRetryAfterMs,
  type ResponseMetadata,
  responseMetadataFromHeaders,
} from './response-metadata';
import {
  failureFromErrorEnvelope,
  failureFromResponse,
  isWireErrorEnvelope,
} from './wire-error-envelope';

const metadata: ResponseMetadata = {
  headers: { 'x-request-id': 'header-request' },
  requestId: 'header-request',
};

describe('operation response metadata', () => {
  it('normalizes readable headers and projects well-known metadata', () => {
    const result = responseMetadataFromHeaders(
      new Headers({
        'X-Request-ID': 'request-1',
        'Retry-After': '12',
        ETag: '"account-1"',
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="report.pdf"',
        'Idempotency-Key': 'create-1',
        'Idempotency-Replayed': 'true',
        'Idempotency-Result': 'replay',
      })
    );

    expect(result).toEqual({
      headers: {
        'content-disposition': 'attachment; filename="report.pdf"',
        'content-type': 'application/json',
        etag: '"account-1"',
        'idempotency-key': 'create-1',
        'idempotency-replayed': 'true',
        'idempotency-result': 'replay',
        'retry-after': '12',
        'x-request-id': 'request-1',
      },
      requestId: 'request-1',
      retryAfterMs: 12_000,
      etag: '"account-1"',
      contentType: 'application/json',
      contentDisposition: 'attachment; filename="report.pdf"',
      idempotencyKey: 'create-1',
      idempotencyReplayed: true,
      idempotencyResult: 'replay',
    });
  });

  it('supports configurable metadata header names and false replay values', () => {
    const result = responseMetadataFromHeaders(
      new Headers({ 'X-Correlation': 'custom-1', 'X-Replayed': 'false' }),
      0,
      { requestId: 'x-correlation', idempotencyReplayed: 'x-replayed' }
    );

    expect(result.requestId).toBe('custom-1');
    expect(result.idempotencyReplayed).toBe(false);
  });

  it('parses Retry-After dates, clamps past dates, and rejects malformed values', () => {
    const now = Date.parse('Sun, 06 Nov 1994 08:49:37 GMT');
    expect(parseRetryAfterMs('Sun, 06 Nov 1994 08:50:37 GMT', now)).toBe(60_000);
    expect(parseRetryAfterMs('Sun, 06 Nov 1994 08:40:37 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('not-a-date', now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });
});

describe('operation application failures', () => {
  it('recognizes only the minimum stable envelope', () => {
    expect(
      isWireErrorEnvelope({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid input' },
      })
    ).toBe(true);
    expect(isWireErrorEnvelope(null)).toBe(false);
    expect(isWireErrorEnvelope([])).toBe(false);
    expect(isWireErrorEnvelope({ success: true, error: {} })).toBe(false);
    expect(isWireErrorEnvelope({ success: false, error: null })).toBe(false);
    expect(isWireErrorEnvelope({ success: false, error: { code: 4, message: 'x' } })).toBe(false);
    expect(isWireErrorEnvelope({ success: false, error: { code: 'X', message: 4 } })).toBe(false);
  });

  it('marks declared codes and retains details, request ID, and additive fields', () => {
    const failure = failureFromErrorEnvelope(
      {
        success: false,
        requestId: 'envelope-request',
        trace: 'trace-1',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: { issues: [{ path: ['name'], code: 'required', message: 'Required' }] },
          requestId: 'error-request',
          documentation: 'validation',
        },
      },
      422,
      metadata,
      ['VALIDATION_ERROR', 'CONFLICT'] as const
    );

    expect(failure.error).toEqual({
      declared: true,
      code: 'VALIDATION_ERROR',
      message: 'Invalid input',
      details: { issues: [{ path: ['name'], code: 'required', message: 'Required' }] },
      requestId: 'header-request',
      extensions: { documentation: 'validation' },
      envelopeExtensions: { trace: 'trace-1' },
    });
  });

  it('marks a well-formed but undeclared code as version skew', () => {
    const failure = failureFromErrorEnvelope(
      { success: false, error: { code: 'NEW_SERVER_CODE', message: 'New failure' } },
      409,
      metadata,
      new Set(['CONFLICT'] as const)
    );

    expect(failure.error).toMatchObject({ declared: false, code: 'NEW_SERVER_CODE' });
  });

  it('adapts a failed value to a lossless presentation exception', () => {
    const failure = failureFromErrorEnvelope(
      { success: false, error: { code: 'NO_USER_RECORD', message: 'No profile' } },
      404,
      metadata,
      ['NO_USER_RECORD'] as const
    );
    const error = new OperationApiError(failure);

    expect(error).toMatchObject({
      name: 'OperationApiError',
      message: 'No profile',
      code: 'NO_USER_RECORD',
      declared: true,
      status: 404,
      requestId: 'header-request',
      headers: metadata,
      error: failure.error,
    });
  });
});

describe('HTTP error response parsing', () => {
  it('returns a declared failure for a valid JSON envelope', async () => {
    const response = new Response(
      JSON.stringify({
        success: false,
        error: { code: 'ACCOUNT_NOT_FOUND', message: 'Missing' },
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'request-2' },
      }
    );

    await expect(
      failureFromResponse(response, ['ACCOUNT_NOT_FOUND'] as const)
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { declared: true, code: 'ACCOUNT_NOT_FOUND', requestId: 'request-2' },
    });
  });

  it('rejects an HTML proxy response as a protocol error', async () => {
    const response = new Response('<html>Bad Gateway</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });

    await expect(failureFromResponse(response, [])).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-content-type',
      status: 502,
      receivedContentType: 'text/html',
    });
  });

  it('rejects malformed JSON as a protocol error', async () => {
    const response = new Response('{', {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(failureFromResponse(response, [])).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'invalid-json',
      status: 500,
    });
  });

  it('rejects a JSON body with the wrong envelope as a protocol error', async () => {
    const response = new Response(JSON.stringify({ message: 'proxy json' }), {
      status: 502,
      headers: { 'Content-Type': 'application/problem+json' },
    });

    await expect(failureFromResponse(response, [])).rejects.toBeInstanceOf(ProtocolError);
    await expect(
      failureFromResponse(
        new Response(JSON.stringify({ message: 'proxy json' }), {
          status: 502,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
        []
      )
    ).rejects.toMatchObject({ reason: 'invalid-envelope' });
  });
});
