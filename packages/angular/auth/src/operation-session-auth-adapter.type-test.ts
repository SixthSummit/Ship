import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import { OperationSessionAuthAdapter, type SessionAuthOperationMap } from './public-api';

interface ContractFixture {
  readonly 'auth.me': {
    readonly input: Record<string, never>;
    readonly success: { readonly 200: { readonly id: string } };
    readonly errors: 'AUTHENTICATION_ERROR';
    readonly transport: 'http';
  };
  readonly 'auth.login': {
    readonly input: { readonly body: { readonly email: string; readonly password: string } };
    readonly success: { readonly 204: undefined };
    readonly errors: 'AUTHENTICATION_ERROR';
    readonly transport: 'http';
  };
  readonly 'avatar.upload': {
    readonly input: { readonly files: { readonly avatar: File } };
    readonly success: { readonly 201: { readonly url: string } };
    readonly errors: 'UPLOAD_FAILED';
    readonly transport: 'upload';
  };
}

declare const client: OperationClient<ContractFixture>;

const operations = {
  me: { operation: 'auth.me', input: () => ({}) },
  signIn: {
    operation: 'auth.login',
    input: ({ email, password }) => ({ body: { email, password } }),
  },
} as const satisfies SessionAuthOperationMap<ContractFixture>;

const adapter = new OperationSessionAuthAdapter<ContractFixture>({
  client,
  operations,
  mapUser: value => ({ uid: (value as { id: string }).id, email: null }),
});

adapter.capabilities.password?.signIn('ada@example.test', 'secret');

const wrongInput = {
  me: { operation: 'auth.me', input: () => ({}) },
  signIn: {
    operation: 'auth.login',
    // @ts-expect-error the login mapping must build the declared body
    input: ({ email }) => ({ body: { email } }),
  },
} satisfies SessionAuthOperationMap<ContractFixture>;

const wrongTransport = {
  // @ts-expect-error upload operations cannot act as unary session operations
  me: { operation: 'avatar.upload', input: () => ({ files: { avatar: new File([], 'a') } }) },
} satisfies SessionAuthOperationMap<ContractFixture>;

void wrongInput;
void wrongTransport;
