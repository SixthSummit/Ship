import { describe, expect, it } from 'vitest';
import {
  createOperationForm,
  defineOperationForm,
  type OperationFormBinding,
  type OperationValidationIssue,
} from './create-operation-form';
import {
  bigintStringOperationFormCodec,
  identityOperationFormCodec,
  isoDateOperationFormCodec,
} from './operation-form-codecs';

interface FormContract {
  readonly 'profiles.update': {
    readonly input: {
      readonly params: { readonly profileId: string };
      readonly body: {
        readonly name: string;
        readonly nickname?: string;
        readonly count: number;
        readonly enabled: boolean;
        readonly note: string | null;
        readonly tags?: readonly string[];
        readonly birthday: string;
        readonly memberNumber: string;
      };
    };
    readonly success: { readonly 200: { readonly saved: true } };
    readonly errors: 'VALIDATION_ERROR';
    readonly transport: 'http';
  };
}

interface ControlValues {
  readonly name: string;
  readonly nickname: string;
  readonly count: number;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly tags: readonly string[];
  readonly birthday: Date;
  readonly memberNumber: bigint;
}

const requiredName = (value: string): readonly OperationValidationIssue[] =>
  value.length > 0 ? [] : [{ path: ['name'], code: 'too_small', message: 'Name is required' }];

const binding: OperationFormBinding<FormContract, 'profiles.update', ControlValues> =
  defineOperationForm<FormContract, 'profiles.update', ControlValues>('profiles.update', {
    fields: {
      name: {
        optional: false,
        initial: { kind: 'value', value: '' },
        codec: identityOperationFormCodec(),
        validate: requiredName,
      },
      nickname: {
        optional: true,
        initial: { kind: 'omitted', controlValue: '' },
        codec: identityOperationFormCodec(),
      },
      count: {
        optional: false,
        initial: { kind: 'value', value: 0 },
        codec: identityOperationFormCodec(),
      },
      enabled: {
        optional: false,
        initial: { kind: 'value', value: false },
        codec: identityOperationFormCodec(),
      },
      note: {
        optional: false,
        initial: { kind: 'value', value: null },
        codec: identityOperationFormCodec(),
      },
      tags: {
        optional: true,
        initial: { kind: 'omitted', controlValue: [] },
        codec: identityOperationFormCodec(),
      },
      birthday: {
        optional: false,
        initial: { kind: 'value', value: new Date('2000-01-02T00:00:00.000Z') },
        codec: isoDateOperationFormCodec,
      },
      memberNumber: {
        optional: false,
        initial: { kind: 'value', value: 42n },
        codec: bigintStringOperationFormCodec,
      },
    },
  });

describe('createOperationForm', () => {
  it('builds exact typed controls without guessing field defaults', () => {
    const operation = createOperationForm(binding);

    expect(Object.keys(operation.form.controls)).toEqual([
      'name',
      'nickname',
      'count',
      'enabled',
      'note',
      'tags',
      'birthday',
      'memberNumber',
    ]);
    expect(operation.form.controls.name.value).toBe('');
    expect(operation.form.controls.count.value).toBe(0);
    expect(operation.form.controls.enabled.value).toBe(false);
    expect(operation.form.controls.note.value).toBeNull();
    expect(operation.form.controls.tags.value).toEqual([]);
    expect(operation.form.controls.birthday.value).toBeInstanceOf(Date);
    expect(operation.form.controls.memberNumber.value).toBe(42n);
    expect(operation.isPresent('nickname')).toBe(false);
    expect(operation.isPresent('tags')).toBe(false);
  });

  it('preserves omitted, empty, zero, false, null, and empty collection semantics', () => {
    const operation = createOperationForm(binding);

    expect(operation.body()).toEqual({
      name: '',
      count: 0,
      enabled: false,
      note: null,
      birthday: '2000-01-02T00:00:00.000Z',
      memberNumber: '42',
    });

    operation.form.controls.nickname.setValue('');
    operation.include('tags');
    expect(operation.body()).toMatchObject({ nickname: '', tags: [] });

    operation.omit('nickname');
    expect(operation.body()).not.toHaveProperty('nickname');
    expect(() => operation.omit('name')).toThrow(TypeError);
  });

  it('decodes a wire body and restores omitted optional fields explicitly', () => {
    const operation = createOperationForm(binding);
    operation.form.controls.nickname.setValue('old');
    operation.form.controls.tags.setValue(['old']);

    operation.setBody({
      name: 'Ada',
      count: 3,
      enabled: true,
      note: null,
      birthday: '1990-05-06T00:00:00.000Z',
      memberNumber: '9007199254740993',
    });

    expect(operation.form.controls.name.value).toBe('Ada');
    expect(operation.form.controls.nickname.value).toBe('');
    expect(operation.form.controls.tags.value).toEqual([]);
    expect(operation.isPresent('nickname')).toBe(false);
    expect(operation.isPresent('tags')).toBe(false);
    expect(operation.form.controls.birthday.value.toISOString()).toBe('1990-05-06T00:00:00.000Z');
    expect(operation.form.controls.memberNumber.value).toBe(9007199254740993n);
  });

  it('surfaces stable client issues without parsing human messages', () => {
    const operation = createOperationForm(binding);

    expect(operation.form.controls.name.getError('ship')).toEqual([
      { path: ['name'], code: 'too_small', message: 'Name is required' },
    ]);
    expect(operation.clientIssues()).toEqual([
      { path: ['name'], code: 'too_small', message: 'Name is required' },
    ]);

    operation.form.controls.name.setValue('Grace');

    expect(operation.form.controls.name.getError('ship')).toBeNull();
    expect(operation.clientIssues()).toEqual([]);
  });

  it('maps server issues by stable path and preserves unrelated Angular errors', () => {
    const operation = createOperationForm(binding);
    operation.form.controls.name.setErrors({ custom: true });
    const fieldIssue = {
      path: ['name'],
      code: 'not_unique',
      message: 'Choose another name',
    } as const;
    const nestedIssue = {
      path: ['unknown', 0],
      code: 'invalid_relation',
      message: 'Unknown relation',
    } as const;

    operation.setServerIssues([fieldIssue, nestedIssue]);

    expect(operation.form.controls.name.getError('shipServer')).toEqual([fieldIssue]);
    expect(operation.form.controls.name.hasError('custom')).toBe(true);
    expect(operation.form.getError('shipServer')).toEqual([nestedIssue]);
    expect(operation.serverIssues()).toEqual([fieldIssue, nestedIssue]);

    operation.form.controls.name.setValue('new value');
    expect(operation.form.controls.name.getError('shipServer')).toBeNull();
    expect(operation.serverIssues()).toEqual([nestedIssue]);

    operation.clearServerIssues();
    expect(operation.serverIssues()).toEqual([]);
    expect(operation.form.getError('shipServer')).toBeNull();
  });

  it('rejects definitions that mark a required field omitted', () => {
    const invalid = {
      ...binding,
      fields: {
        ...binding.fields,
        name: { ...binding.fields.name, initial: { kind: 'omitted', controlValue: '' } },
      },
    } satisfies OperationFormBinding<FormContract, 'profiles.update', ControlValues>;

    expect(() => createOperationForm(invalid)).toThrow(
      'Required operation form field cannot start omitted: name'
    );
  });

  it('fails explicitly when a required wire body field is absent', () => {
    const operation = createOperationForm(binding);

    expect(() =>
      operation.setBody({
        name: 'Ada',
        count: 1,
        enabled: true,
        note: null,
        birthday: '2000-01-01T00:00:00.000Z',
      } as never)
    ).toThrow('Operation body is missing required form field: memberNumber');
  });

  it('tears down presence tracking when destroyed', () => {
    const operation = createOperationForm(binding);
    operation.destroy();

    operation.form.controls.nickname.setValue('after destroy');

    expect(operation.isPresent('nickname')).toBe(false);
  });
});

describe('operation form codecs', () => {
  it('rejects invalid dates in either direction', () => {
    expect(() => isoDateOperationFormCodec.decode('not-a-date')).toThrow(RangeError);
    expect(() => isoDateOperationFormCodec.encode(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('round trips bigint strings without number precision loss', () => {
    const value = bigintStringOperationFormCodec.decode('900719925474099312345');
    expect(bigintStringOperationFormCodec.encode(value)).toBe('900719925474099312345');
  });
});
