import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { HttpRequestError } from './HttpRequestError';

describe('HttpRequestError', () => {
  it('prefers the response header request ID and nested ShipAPI-compatible fields', () => {
    const source = new HttpErrorResponse({
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: new HttpHeaders({ 'X-Request-ID': 'header-request', 'Retry-After': '10' }),
      error: {
        requestId: 'outer-request',
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: { issues: [] },
          requestId: 'inner-request',
        },
      },
    });

    expect(HttpRequestError.fromHttpErrorResponse(source)).toMatchObject({
      status: 422,
      statusText: 'Unprocessable Entity',
      message: 'Invalid input',
      requestId: 'header-request',
      code: 'VALIDATION_ERROR',
      details: { issues: [] },
      headers: { 'retry-after': '10', 'x-request-id': 'header-request' },
      responseBody: source.error,
    });
  });

  it('supports a flat third-party error shape', () => {
    const source = new HttpErrorResponse({
      status: 409,
      statusText: 'Conflict',
      error: {
        code: 'DUPLICATE',
        message: 'Already exists',
        details: { field: 'email' },
        requestId: 'flat-request',
      },
    });

    expect(HttpRequestError.fromHttpErrorResponse(source)).toMatchObject({
      message: 'Already exists',
      requestId: 'flat-request',
      code: 'DUPLICATE',
      details: { field: 'email' },
    });
  });

  it('retains primitive proxy bodies and falls back to Angular transport context', () => {
    const source = new HttpErrorResponse({
      status: 502,
      statusText: 'Bad Gateway',
      error: '<html>Bad Gateway</html>',
      url: 'https://api.example.test/report',
    });
    const error = HttpRequestError.fromHttpErrorResponse(source);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('502');
    expect(error.responseBody).toBe('<html>Bad Gateway</html>');
    expect(error.code).toBeUndefined();
    expect(error.details).toBeUndefined();
    expect(error.requestId).toBeUndefined();
  });
});
