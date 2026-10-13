import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSchemaForm } from './createSchemaForm';

describe('createSchemaForm', () => {
  it('builds a FormGroup with one FormControl per shape field', () => {
    const schema = z.object({ email: z.string(), age: z.number() });
    const form = createSchemaForm(schema);
    expect(Object.keys(form.controls)).toEqual(['email', 'age']);
  });

  it('seeds string controls with empty string and number controls with 0', () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    const form = createSchemaForm(schema);
    expect(form.controls.name.value).toBe('');
    // Number defaults to 0 (empty-of-type for number). Optional + 0 is
    // a valid form-empty state; the Zod validator gates submit if the
    // schema rejects it.
    expect(form.controls.count.value).toBe(0);
  });

  it('honours per-field defaults', () => {
    const schema = z.object({ email: z.string().email(), age: z.number() });
    const form = createSchemaForm(schema, { age: 21 });
    expect(form.controls.age.value).toBe(21);
    expect(form.controls.email.value).toBe('');
  });

  it('seeds optional string fields to empty string (empty-of-type)', () => {
    const schema = z.object({ bio: z.string().optional() });
    const form = createSchemaForm(schema);
    // Optional fields default to empty-of-type rather than null/undefined,
    // so the FormControl stays typed as FormControl<string>. Submit-time
    // semantics are handled by the Zod validator.
    expect(form.controls.bio.value).toBe('');
  });

  it('flags required fields as invalid when empty', () => {
    const schema = z.object({ email: z.string() });
    const form = createSchemaForm(schema);
    expect(form.controls.email.hasError('required')).toBe(true);
  });

  it('does NOT require optional fields', () => {
    const schema = z.object({ bio: z.string().optional() });
    const form = createSchemaForm(schema);
    expect(form.controls.bio.hasError('required')).toBe(false);
  });

  it('runs Zod validation and emits a zod error with the issue message', () => {
    const schema = z.object({ email: z.string().email() });
    const form = createSchemaForm(schema);
    form.controls.email.setValue('not-an-email');
    expect(form.controls.email.hasError('zod')).toBe(true);
    const msg = form.controls.email.getError('zod') as string;
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('clears the zod error when the value becomes valid', () => {
    const schema = z.object({ email: z.string().email() });
    const form = createSchemaForm(schema);
    form.controls.email.setValue('not-an-email');
    expect(form.controls.email.hasError('zod')).toBe(true);
    form.controls.email.setValue('user@example.test');
    expect(form.controls.email.hasError('zod')).toBe(false);
  });

  it('respects min / max constraints from the schema', () => {
    const schema = z.object({ count: z.number().min(1).max(10) });
    const form = createSchemaForm(schema, { count: 0 });
    expect(form.controls.count.hasError('zod')).toBe(true);
    form.controls.count.setValue(5);
    expect(form.controls.count.hasError('zod')).toBe(false);
    form.controls.count.setValue(11);
    expect(form.controls.count.hasError('zod')).toBe(true);
  });

  it('supports optional + min — empty is valid, non-empty must satisfy min', () => {
    const schema = z.object({ bio: z.string().min(10).optional() });
    const form = createSchemaForm(schema);
    // empty optional field — valid
    expect(form.controls.bio.hasError('zod')).toBe(false);
    form.controls.bio.setValue('short');
    expect(form.controls.bio.hasError('zod')).toBe(true);
    form.controls.bio.setValue('a long enough biography');
    expect(form.controls.bio.hasError('zod')).toBe(false);
  });

  it('treats the FormGroup as invalid when any control is invalid', () => {
    const schema = z.object({ email: z.string().email() });
    const form = createSchemaForm(schema);
    form.controls.email.setValue('bad');
    expect(form.invalid).toBe(true);
    form.controls.email.setValue('user@example.test');
    expect(form.invalid).toBe(false);
  });

  it('handles boolean fields with default false', () => {
    const schema = z.object({ accepted: z.boolean() });
    const form = createSchemaForm(schema);
    expect(form.controls.accepted.value).toBe(false);
  });
});
