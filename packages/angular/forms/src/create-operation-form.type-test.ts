import {
  createOperationForm,
  defineOperationForm,
  identityOperationFormCodec,
  type OperationFormBinding,
} from './public-api';

interface Contract {
  readonly 'accounts.create': {
    readonly input: {
      readonly body: { readonly email: string; readonly age?: number };
    };
    readonly success: { readonly 201: { readonly id: string } };
    readonly errors: 'INVALID';
    readonly transport: 'http';
  };
  readonly 'accounts.get': {
    readonly input: { readonly params: { readonly accountId: string } };
    readonly success: { readonly 200: { readonly id: string } };
    readonly errors: 'NOT_FOUND';
    readonly transport: 'http';
  };
}

interface Values {
  readonly email: string;
  readonly age: number;
}

const binding = defineOperationForm<Contract, 'accounts.create', Values>('accounts.create', {
  fields: {
    email: {
      optional: false,
      initial: { kind: 'value', value: '' },
      codec: identityOperationFormCodec(),
    },
    age: {
      optional: true,
      initial: { kind: 'omitted', controlValue: 0 },
      codec: identityOperationFormCodec(),
    },
  },
});

const operation = createOperationForm(binding);
const email: string = operation.form.controls.email.value;
const body: { readonly email: string; readonly age?: number } = operation.body();
void email;
void body;

// @ts-expect-error An operation without a body cannot own a form binding.
const noBody: OperationFormBinding<Contract, 'accounts.get', Values> = binding;
void noBody;

defineOperationForm<Contract, 'accounts.create', Values>('accounts.create', {
  fields: {
    email: {
      optional: false,
      initial: { kind: 'value', value: '' },
      codec: identityOperationFormCodec(),
    },
    age: {
      optional: true,
      initial: { kind: 'omitted', controlValue: 0 },
      // @ts-expect-error The age codec must encode the operation body's number field.
      codec: identityOperationFormCodec<string>(),
    },
  },
});
