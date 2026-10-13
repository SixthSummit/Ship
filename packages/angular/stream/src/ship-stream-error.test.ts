import { describe, expect, it } from 'vitest';
import { isShipStreamError } from './ship-stream-error';

describe('isShipStreamError', () => {
  it('accepts the wire error object', () => {
    expect(isShipStreamError({ code: 'X', status: 500, message: 'boom' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'boom'],
    ['an array', [{ code: 'X', status: 500, message: 'boom' }]],
    ['an empty code', { code: '', status: 500, message: 'boom' }],
    ['a missing code', { status: 500, message: 'boom' }],
    ['a fractional status', { code: 'X', status: 1.5, message: 'boom' }],
    ['a non-string message', { code: 'X', status: 500, message: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(isShipStreamError(value)).toBe(false);
  });
});
