import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ApiErrorCode,
  type ApiErrorEnvelope,
  parseRetryAfter,
  RateLimitError,
} from './ApiError';

const makeEnvelope = (overrides: Partial<ApiErrorEnvelope['error']> = {}): ApiErrorEnvelope => ({
  success: false,
  error: { code: 'AUTHENTICATION_ERROR', message: 'no token', ...overrides },
});

describe('ApiError', () => {
  it('exposes code, message, status, and details from the envelope', () => {
    const err = new ApiError(makeEnvelope({ details: { field: 'email' } }), 401);
    expect(err.message).toBe('no token');
    expect(err.code).toBe('AUTHENTICATION_ERROR');
    expect(err.status).toBe(401);
    expect(err.details).toEqual({ field: 'email' });
    expect(err.name).toBe('ApiError');
  });

  it('is instanceof Error and ApiError (prototype chain restored)', () => {
    const err = new ApiError(makeEnvelope(), 401);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('isEnvelope narrows correctly on well-shaped input', () => {
    expect(ApiError.isEnvelope({ success: false, error: { code: 'X', message: 'y' } })).toBe(true);
    expect(ApiError.isEnvelope({ success: true, data: 'x' })).toBe(false);
    expect(ApiError.isEnvelope({ success: false })).toBe(false);
    expect(ApiError.isEnvelope({ success: false, error: {} })).toBe(false);
    expect(ApiError.isEnvelope({ success: false, error: { code: 'X' } })).toBe(false);
    expect(ApiError.isEnvelope(null)).toBe(false);
    expect(ApiError.isEnvelope('not an object')).toBe(false);
  });

  it('fromEnvelope returns RateLimitError for 429', () => {
    const err = ApiError.fromEnvelope(
      makeEnvelope({ code: ApiErrorCode.RateLimitExceeded, message: 'Too many requests' }),
      429
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe(ApiErrorCode.RateLimitExceeded);
    expect(err.status).toBe(429);
  });

  it('fromEnvelope returns ApiError for other statuses', () => {
    const err = ApiError.fromEnvelope(makeEnvelope(), 401);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(RateLimitError);
  });

  it('fromResponse builds from a Response with a ShipAPI envelope body', async () => {
    const body = makeEnvelope({ code: 'VALIDATION_ERROR', details: { fields: ['email'] } });
    const res = new Response(JSON.stringify(body), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    const err = await ApiError.fromResponse(res);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.status).toBe(400);
    expect(err.details).toEqual({ fields: ['email'] });
  });

  it('fromResponse synthesizes an envelope when the body is not envelope-shaped', async () => {
    const res = new Response('<html>Bad Gateway</html>', {
      status: 502,
      statusText: 'Bad Gateway',
    });
    const err = await ApiError.fromResponse(res);
    expect(err.code).toBe(ApiErrorCode.Internal);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Bad Gateway');
  });

  it('fromResponse synthesizes an envelope when the body is not parseable JSON', async () => {
    const res = new Response('not json', { status: 500 });
    const err = await ApiError.fromResponse(res);
    expect(err.code).toBe(ApiErrorCode.Internal);
    expect(err.status).toBe(500);
  });

  it('fromResponse returns RateLimitError on 429 with Retry-After', async () => {
    const body = makeEnvelope({ code: ApiErrorCode.RateLimitExceeded, message: 'Too many' });
    const res = new Response(JSON.stringify(body), {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '12' },
    });
    const err = await ApiError.fromResponse(res);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSec).toBe(12);
  });

  it('fromResponse returns RateLimitError with retryAfterSec=0 when header is missing', async () => {
    const body = makeEnvelope({ code: ApiErrorCode.RateLimitExceeded, message: 'Too many' });
    const res = new Response(JSON.stringify(body), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
    const err = await ApiError.fromResponse(res);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSec).toBe(0);
  });

  it('fromResponse maps non-envelope 429s and still returns RateLimitError', async () => {
    const res = new Response('rate limit', { status: 429, headers: { 'Retry-After': '5' } });
    const err = await ApiError.fromResponse(res);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe(ApiErrorCode.RateLimitExceeded);
    expect((err as RateLimitError).retryAfterSec).toBe(5);
  });

  it('codeForStatus default mapping: 401 → AUTHENTICATION_ERROR for synthetic envelopes', async () => {
    const res = new Response('', { status: 401 });
    const err = await ApiError.fromResponse(res);
    expect(err.code).toBe(ApiErrorCode.Authentication);
  });

  it('uncategorised status falls back to HTTP_<status>', async () => {
    const res = new Response('', { status: 418 });
    const err = await ApiError.fromResponse(res);
    expect(err.code).toBe('HTTP_418');
  });
});

describe('RateLimitError', () => {
  it('extends ApiError and exposes retryAfterSec', () => {
    const err = new RateLimitError(
      makeEnvelope({ code: ApiErrorCode.RateLimitExceeded, message: 'Too many' }),
      429,
      30
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSec).toBe(30);
    expect(err.name).toBe('RateLimitError');
  });
});

describe('parseRetryAfter', () => {
  it('parses integer-seconds form', () => {
    const res = new Response('', { headers: { 'Retry-After': '42' } });
    expect(parseRetryAfter(res)).toBe(42);
  });

  it('parses HTTP-date form relative to now', () => {
    const now = Date.parse('Sun, 06 Nov 1994 08:49:37 GMT');
    const res = new Response('', {
      headers: { 'Retry-After': 'Sun, 06 Nov 1994 08:50:37 GMT' },
    });
    expect(parseRetryAfter(res, now)).toBe(60);
  });

  it('returns 0 when past or missing', () => {
    const now = Date.parse('Sun, 06 Nov 1994 08:50:00 GMT');
    const past = new Response('', {
      headers: { 'Retry-After': 'Sun, 06 Nov 1994 08:49:37 GMT' },
    });
    expect(parseRetryAfter(past, now)).toBe(0);
    expect(parseRetryAfter(new Response(''))).toBe(0);
  });

  it('returns 0 on malformed input', () => {
    const res = new Response('', { headers: { 'Retry-After': 'not a date' } });
    expect(parseRetryAfter(res)).toBe(0);
  });
});
