import { describe, expect, it } from 'vitest';
import { formatInstant, formatJson, formatTrigger } from './console-format';

describe('console formatting helpers', () => {
  it('formats instants, triggers and bounded JSON', () => {
    expect(formatInstant(undefined)).toBe('—');
    expect(formatInstant('not a date')).toBe('not a date');
    expect(formatInstant('2026-10-22T12:34:56.789Z')).toBe('2026-10-22 12:34:56');
    expect(formatTrigger(undefined)).toBe('—');
    expect(formatTrigger({ kind: 'schedule', cron: '0 6 * * *', tz: 'UTC' })).toBe(
      '0 6 * * * (UTC)'
    );
    expect(formatTrigger({ kind: 'schedule' })).toBe(' (UTC)');
    expect(formatTrigger({ kind: 'interval', everyMs: 500 })).toBe('every 500 ms');
    expect(formatTrigger({ kind: 'interval' })).toBe('every 0 ms');
    expect(formatTrigger({ kind: 'enqueue' })).toBe('enqueue');
    expect(formatJson(undefined)).toBe('—');
    expect(formatJson({ a: 1 })).toBe('{"a":1}');
    expect(formatJson('x'.repeat(200), 10)).toBe(`${'"'}${'x'.repeat(9)}…`);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatJson(circular)).toBe('[object Object]');
  });
});
