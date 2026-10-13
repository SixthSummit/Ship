import { describe, expect, it } from 'vitest';
import { TruncatePipe } from './TruncatePipe';

// TruncatePipe is a pure transform — no DI, no TestBed needed.
describe('TruncatePipe', () => {
  const pipe = new TruncatePipe();

  it('returns short strings unchanged', () => {
    expect(pipe.transform('hello', 20)).toBe('hello');
  });

  it('truncates long strings to limit and appends the default ellipsis', () => {
    const result = pipe.transform('the quick brown fox jumps', 10);
    expect(result.length).toBeLessThanOrEqual(13); // 10 chars + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles null / undefined input gracefully', () => {
    expect(pipe.transform(null as unknown as string, 10)).toBe('');
    expect(pipe.transform(undefined as unknown as string, 10)).toBe('');
  });

  it('uses a custom suffix when provided', () => {
    const result = pipe.transform('the quick brown fox', 10, false, ' [more]');
    expect(result.endsWith(' [more]')).toBe(true);
  });

  it('respects word boundaries when completeWords is true', () => {
    const result = pipe.transform('the quick brown fox', 10, true);
    // Truncates at the last space before char 10 ("the quick" = 9 chars).
    expect(result).toBe('the quick...');
  });
});
