import { type Signal, signal } from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  type ValidationErrors,
  type ValidatorFn,
} from '@angular/forms';
import type { InputOf, OperationId } from '@sixthsummit/ship-angular/operations';
import type { Subscription } from 'rxjs';
import type { OperationFormCodec } from './operation-form-codecs';

export type OperationBodyOf<TContract extends object, TId extends OperationId<TContract>> =
  InputOf<TContract, TId> extends { readonly body: infer TBody extends object } ? TBody : never;

export type BodyOperationId<TContract extends object> = {
  [TId in OperationId<TContract>]: OperationBodyOf<TContract, TId> extends never ? never : TId;
}[OperationId<TContract>];

export interface OperationValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export type OperationFormInitial<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'omitted'; readonly controlValue: T };

export interface OperationFormField<TControl, TWire> {
  /** Optionality is emitted by the client-safe operation body projection. */
  readonly optional: boolean;
  /** Explicit initial/presence state; the frontend never guesses from a schema probe. */
  readonly initial: OperationFormInitial<TControl>;
  readonly codec: OperationFormCodec<TControl, TWire>;
  readonly validate?: (value: TControl) => readonly OperationValidationIssue[];
}

export interface OperationFormDefinition<TValues extends object, TBody extends object> {
  readonly fields: {
    readonly [TKey in keyof TValues]-?: OperationFormField<
      TValues[TKey],
      TKey extends keyof TBody ? Exclude<TBody[TKey], undefined> : never
    >;
  };
}

export interface OperationFormBinding<
  TContract extends object,
  TId extends BodyOperationId<TContract>,
  TValues extends object,
> extends OperationFormDefinition<TValues, OperationBodyOf<TContract, TId>> {
  readonly operation: TId;
}

export type OperationFormControls<TValues extends object> = {
  [TKey in keyof TValues]-?: FormControl<TValues[TKey]>;
};

export interface OperationForm<TValues extends object, TBody extends object> {
  readonly form: FormGroup<OperationFormControls<TValues>>;
  readonly clientIssues: Signal<readonly OperationValidationIssue[]>;
  readonly serverIssues: Signal<readonly OperationValidationIssue[]>;
  readonly presentFields: Signal<ReadonlySet<keyof TValues>>;
  body(): TBody;
  include<TKey extends keyof TValues>(field: TKey): void;
  omit<TKey extends keyof TValues>(field: TKey): void;
  isPresent<TKey extends keyof TValues>(field: TKey): boolean;
  setBody(body: TBody): void;
  setServerIssues(issues: readonly OperationValidationIssue[]): void;
  clearServerIssues(): void;
  destroy(): void;
}

/** Identity helper for generated client-safe form definitions. */
export function defineOperationForm<
  TContract extends object,
  TId extends BodyOperationId<TContract>,
  TValues extends object,
>(
  operation: TId,
  definition: OperationFormDefinition<TValues, OperationBodyOf<TContract, TId>>
): OperationFormBinding<TContract, TId, TValues> {
  return { operation, ...definition };
}

/** Build a typed Angular form for one operation body without importing a server schema runtime. */
export function createOperationForm<
  TContract extends object,
  TId extends BodyOperationId<TContract>,
  TValues extends object,
>(
  definition: OperationFormBinding<TContract, TId, TValues>
): OperationForm<TValues, OperationBodyOf<TContract, TId>> {
  type Body = OperationBodyOf<TContract, TId>;
  const controls = {} as OperationFormControls<TValues>;
  const initialPresence = new Set<keyof TValues>();
  const fieldEntries = Object.entries(definition.fields) as Array<
    [keyof TValues, OperationFormField<TValues[keyof TValues], unknown>]
  >;
  for (const [name, field] of fieldEntries) {
    if (!field.optional && field.initial.kind === 'omitted') {
      throw new TypeError(`Required operation form field cannot start omitted: ${String(name)}`);
    }
    if (field.initial.kind === 'value') initialPresence.add(name);
    controls[name] = new FormControl(
      field.initial.kind === 'value' ? field.initial.value : field.initial.controlValue,
      {
        nonNullable: true,
        validators: field.validate === undefined ? [] : [operationFieldValidator(field.validate)],
      }
    ) as OperationFormControls<TValues>[keyof TValues];
  }

  const form = new FormGroup(controls);
  const presence = signal<ReadonlySet<keyof TValues>>(new Set(initialPresence));
  const serverIssueState = signal<readonly OperationValidationIssue[]>([]);
  const subscriptions: Subscription[] = [];
  const clientIssueState = signal<readonly OperationValidationIssue[]>(collectClientIssues(form));
  subscriptions.push(
    form.statusChanges.subscribe(() => clientIssueState.set(collectClientIssues(form)))
  );
  for (const [name] of fieldEntries) {
    subscriptions.push(
      controls[name].valueChanges.subscribe(() => {
        if (!presence().has(name)) {
          presence.update(current => new Set([...current, name]));
        }
        removeError(controls[name], 'shipServer');
        serverIssueState.update(current => current.filter(issue => issue.path[0] !== name));
      })
    );
  }

  const clearAppliedServerIssues = () => {
    for (const control of Object.values(controls) as AbstractControl[]) {
      removeError(control, 'shipServer');
    }
    removeError(form, 'shipServer');
  };

  const setServerIssues = (issues: readonly OperationValidationIssue[]) => {
    clearAppliedServerIssues();
    const byField = new Map<keyof TValues, OperationValidationIssue[]>();
    const formIssues: OperationValidationIssue[] = [];
    for (const issue of issues) {
      const field = issue.path[0] as keyof TValues | undefined;
      if (field === undefined || !(field in controls)) {
        formIssues.push(issue);
        continue;
      }
      const current = byField.get(field) ?? [];
      current.push(issue);
      byField.set(field, current);
    }
    for (const [field, fieldIssues] of byField) {
      controls[field].setErrors({ ...(controls[field].errors ?? {}), shipServer: fieldIssues });
    }
    if (formIssues.length > 0) {
      form.setErrors({ ...(form.errors ?? {}), shipServer: formIssues });
    }
    serverIssueState.set(Object.freeze([...issues]));
  };

  return {
    form,
    clientIssues: clientIssueState.asReadonly(),
    serverIssues: serverIssueState.asReadonly(),
    presentFields: presence.asReadonly(),
    body: () => {
      const encoded: Record<PropertyKey, unknown> = {};
      for (const [name, field] of fieldEntries) {
        if (field.optional && !presence().has(name)) continue;
        encoded[name] = field.codec.encode(controls[name].value);
      }
      return encoded as Body;
    },
    include: field => presence.update(current => new Set([...current, field])),
    omit: field => {
      if (!definition.fields[field].optional) {
        throw new TypeError(`Required operation form field cannot be omitted: ${String(field)}`);
      }
      presence.update(current => {
        const next = new Set(current);
        next.delete(field);
        return next;
      });
    },
    isPresent: field => presence().has(field),
    setBody: body => {
      const record = body as Readonly<Record<PropertyKey, unknown>>;
      const nextPresence = new Set<keyof TValues>();
      for (const [name, field] of fieldEntries) {
        if (Object.prototype.hasOwnProperty.call(record, name)) {
          controls[name].setValue(field.codec.decode(record[name]));
          nextPresence.add(name);
        } else if (field.optional) {
          controls[name].setValue(
            field.initial.kind === 'value' ? field.initial.value : field.initial.controlValue
          );
        } else {
          throw new TypeError(`Operation body is missing required form field: ${String(name)}`);
        }
      }
      presence.set(nextPresence);
    },
    setServerIssues,
    clearServerIssues: () => {
      clearAppliedServerIssues();
      serverIssueState.set([]);
    },
    destroy: () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
    },
  };
}

function operationFieldValidator<T>(
  validate: (value: T) => readonly OperationValidationIssue[]
): ValidatorFn {
  return (control: AbstractControl<T>): ValidationErrors | null => {
    const issues = validate(control.value);
    return issues.length === 0 ? null : { ship: issues };
  };
}

function collectClientIssues<TValues extends object>(
  form: FormGroup<OperationFormControls<TValues>>
): readonly OperationValidationIssue[] {
  const issues: OperationValidationIssue[] = [];
  for (const control of Object.values(form.controls) as AbstractControl[]) {
    const fieldIssues = control.getError('ship') as readonly OperationValidationIssue[] | undefined;
    if (fieldIssues != null) issues.push(...fieldIssues);
  }
  return issues;
}

function removeError(control: AbstractControl, key: string): void {
  if (control.errors === null || !(key in control.errors)) return;
  const next = { ...control.errors };
  delete next[key];
  control.setErrors(Object.keys(next).length === 0 ? null : next);
}
