import {
  AbstractControl,
  FormControl,
  FormGroup,
  type ValidationErrors,
  type ValidatorFn,
  Validators,
} from '@angular/forms';

/**
 * Build a typed `FormGroup` from a structural Zod-like object schema.
 *
 * Each top-level field becomes a `FormControl` with:
 *
 * - **A default value** — `''` for strings, `0` for numbers, `false` for
 *   booleans, `null` for nullable / optional, plus `defaults` overrides
 *   per field.
 * - **A Zod-backed validator** — runs the field's schema on every
 *   `valueChanges` and emits `{ zod: string }` with the first issue's
 *   message when invalid.
 * - **`Validators.required`** when the field is not `.optional()`.
 *
 * Zod is the source of truth: don't duplicate constraints in Angular
 * validators alongside the schema. The framework's primitive coerces
 * Zod issues into Angular's validator-error shape so existing
 * `<app-validation-messages>` rendering works unchanged.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { createSchemaForm } from '@sixthsummit/ship-angular';
 *
 * const schema = z.object({
 *   email: z.string().email(),
 *   age: z.number().int().min(13),
 *   bio: z.string().min(50).optional(),
 * });
 *
 * const form = createSchemaForm(schema, { age: 18 });
 * // form.controls.email: FormControl<string>
 * // form.controls.age:   FormControl<number>
 * // form.controls.bio:   FormControl<string | undefined>
 * ```
 *
 * This helper is retained for third-party/browser-owned schemas. ShipAPI
 * operation forms use `createOperationForm()` from the `/forms` entrypoint so
 * browser code never imports Drizzle, backend modules, or server-only schema
 * refinements.
 *
 * @deprecated For ShipAPI integration, use `createOperationForm()` from
 * `@sixthsummit/ship-angular/forms`. This compatibility helper guesses control
 * defaults and cannot preserve omitted/null/empty wire semantics.
 */
export type SchemaFormGroup<T> = FormGroup<{
  // `-?` strips the optional-property modifier — every shape key produces
  // a control, even if the schema field is `.optional()`. `NonNullable`
  // strips `| undefined` from the value type, so optional schema fields
  // produce `FormControl<string>` (with empty-of-type default `''`)
  // rather than `FormControl<string | undefined>`. The Zod validator
  // still gates submit, so optional-field semantics are preserved at the
  // value level — but field components stay typed against `FormControl<T>`
  // rather than `FormControl<T | undefined>`, which keeps the typed-form
  // boundary clean and avoids invariance gymnastics in templates.
  [K in keyof T]-?: FormControl<NonNullable<T[K]>>;
}>;

/**
 * Structural type for the subset of `ZodObject` we use. Keeps the
 * primitive compatible across Zod 3.x and 4.x — both expose `.shape`
 * and the `safeParse` / `isOptional` predicates we read.
 */
export interface ZodObjectLike {
  readonly shape: Record<string, ZodFieldLike>;
}

interface ZodFieldLike {
  safeParse(value: unknown): { success: boolean; error?: { issues: { message: string }[] } };
  isOptional?(): boolean;
  isNullable?(): boolean;
}

/**
 * Create a typed FormGroup from a Zod object schema.
 *
 * The TypeScript inference is keyed off the schema parameter; pass
 * `z.infer<typeof schema>` as the second generic argument when you want
 * the FormGroup's value type checked at the call site:
 *
 * ```ts
 * const schema = z.object({ email: z.string().email() });
 * const form = createSchemaForm<typeof schema, z.infer<typeof schema>>(schema);
 * ```
 *
 * For most cases, the inferred-type generic is unnecessary — Angular's
 * template type-check will pick up errors via the `FormControl<T>`
 * shape derived from the schema.
 *
 * @param schema The Zod schema to derive the form from.
 * @param defaults Optional per-field default values.
 * @deprecated For ShipAPI integration, use `createOperationForm()` from
 * `@sixthsummit/ship-angular/forms`.
 */
export function createSchemaForm<T extends ZodObjectLike, V = Record<string, unknown>>(
  schema: T,
  defaults?: Partial<V>
): SchemaFormGroup<V> {
  const controls: Record<string, FormControl> = {};
  const defaultsRecord = (defaults as Record<string, unknown> | undefined) ?? {};

  for (const [field, fieldSchema] of Object.entries(schema.shape)) {
    const isOptional = fieldSchema.isOptional?.() ?? false;
    const validators: ValidatorFn[] = [zodValidator(fieldSchema)];
    if (!isOptional) validators.push(Validators.required);
    const defaultValue =
      field in defaultsRecord ? defaultsRecord[field] : guessDefault(fieldSchema, isOptional);
    controls[field] = new FormControl(defaultValue, {
      nonNullable: !isOptional && defaultValue !== null,
      validators,
    });
  }

  return new FormGroup(controls) as unknown as SchemaFormGroup<V>;
}

/**
 * Build an Angular validator that delegates to a Zod field schema.
 * Emits `{ zod: <message> }` with the first Zod issue's message on
 * validation failure. Existing `<app-validation-messages>` integration
 * picks `zod` up via the default validator-error map.
 */
export function zodValidator(fieldSchema: ZodFieldLike): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    // Don't fail on empty optional fields — Validators.required handles
    // empties, and Zod's `.optional()` accepts `undefined`.
    if (value === null || value === undefined || value === '') {
      const isOpt = fieldSchema.isOptional?.() ?? false;
      if (isOpt) return null;
      // Required + empty: defer to Validators.required, not the Zod path.
      return null;
    }
    const result = fieldSchema.safeParse(value);
    if (result.success) return null;
    const first = result.error?.issues?.[0]?.message ?? 'Invalid value';
    return { zod: first };
  };
}

function guessDefault(fieldSchema: ZodFieldLike, _isOptional: boolean): unknown {
  // Probe with permissive sentinels per base type. Refinements like
  // `.email()` reject empty strings, so we try a few non-empty values to
  // detect "string-ness" without reaching for Zod internals — then
  // return the conventional empty default for the form's initial state.
  // Validation will flag the empty as invalid until the user fills it in.
  //
  // Optional and required fields BOTH produce empty-of-type defaults:
  // optional fields submit as `''` / `0` / `false` rather than `null` /
  // `undefined`, so `FormControl<T>` stays typed against the non-null
  // value. The Zod validator runs on every change and accepts/rejects
  // per the schema (an optional `z.string().min(50)` accepts `''`, a
  // required `z.string().min(50)` rejects `''` via the required +
  // min-length validators).
  if (probeAny(fieldSchema, ['a', 'a@b.test', 'abcdefghijk', ''])) return '';
  if (probeAny(fieldSchema, [0, 1, 42, 3.14])) return 0;
  if (probeAny(fieldSchema, [false, true])) return false;
  if (fieldSchema.safeParse([]).success) return [];
  if (fieldSchema.safeParse({}).success) return {};
  return null;
}

function probeAny(schema: ZodFieldLike, values: readonly unknown[]): boolean {
  for (const value of values) {
    if (schema.safeParse(value).success) return true;
  }
  return false;
}
