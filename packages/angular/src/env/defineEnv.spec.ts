import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEnv } from './defineEnv';

describe('defineEnv', () => {
  const schema = z.object({
    apiBase: z.string().url(),
    production: z.boolean(),
    firebase: z.object({
      apiKey: z.string().min(1),
    }),
  });

  it('returns a frozen object on valid input', () => {
    const env = defineEnv(schema, {
      apiBase: 'https://api.test',
      production: false,
      firebase: { apiKey: 'real-key' },
    });
    expect(env).toEqual({
      apiBase: 'https://api.test',
      production: false,
      firebase: { apiKey: 'real-key' },
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('throws with the failed path + reason on invalid input', () => {
    expect(() =>
      defineEnv(schema, {
        apiBase: 'not-a-url',
        production: 'yes' as unknown as boolean,
        firebase: { apiKey: '' },
      })
    ).toThrowError(/apiBase|production|firebase\.apiKey/);
  });

  it('surfaces the schema error message in the thrown error', () => {
    let captured: Error | undefined;
    try {
      defineEnv(schema, {
        apiBase: 'https://api.test',
        production: true,
        firebase: { apiKey: '' },
      });
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.message).toContain('Environment validation failed');
    expect(captured!.message).toContain('firebase.apiKey');
  });

  it('handles missing required fields', () => {
    expect(() =>
      // @ts-expect-error — deliberately missing fields for the test.
      defineEnv(schema, { apiBase: 'https://api.test' })
    ).toThrow();
  });

  it('passes a Zod-default-applied value through unchanged', () => {
    const withDefaults = z.object({
      timeout: z.number().default(5000),
    });
    const result = defineEnv(withDefaults, {} as unknown as { timeout: number });
    expect(result.timeout).toBe(5000);
  });
});
