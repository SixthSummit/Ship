import {
  createOperationMutation,
  createOperationResource,
  type OperationClient,
  type OperationResultOf,
} from '@sixthsummit/ship-angular/operations';

interface ContractFixture {
  readonly 'accounts.get': {
    readonly input: {
      readonly params: { readonly accountId: string };
      readonly query?: { readonly include?: readonly ('owner' | 'teams')[] };
      readonly body?: never;
    };
    readonly success: {
      readonly 200: { readonly id: string; readonly ownerId: string | null };
    };
    readonly errors: 'AUTHENTICATION_ERROR' | 'ACCOUNT_NOT_FOUND';
    readonly transport: 'http';
  };
  readonly 'accounts.create': {
    readonly input: {
      readonly body: { readonly name: string };
      readonly params?: never;
      readonly query?: never;
    };
    readonly success: {
      readonly 201: { readonly id: string };
    };
    readonly errors: 'VALIDATION_ERROR' | 'CONFLICT';
    readonly transport: 'http';
  };
  readonly 'reports.download': {
    readonly input: { readonly params: { readonly reportId: string } };
    readonly success: { readonly 200: Blob };
    readonly errors: 'REPORT_NOT_FOUND';
    readonly transport: 'download';
  };
}

declare const client: OperationClient<ContractFixture>;

client.call('accounts.get', {
  params: { accountId: 'account-1' },
  query: { include: ['owner'] },
});
client.call('accounts.create', { body: { name: 'Ada' } }, { idempotencyKey: 'create-1' });

const account = createOperationResource(client, 'accounts.get', () => ({
  params: { accountId: 'account-1' },
}));
const createAccount = createOperationMutation(client, 'accounts.create');
createAccount.execute({ body: { name: 'Ada' } });

const accountId: string | undefined = account.value()?.id;
void accountId;

// @ts-expect-error operation resource input must include the path parameter
createOperationResource(client, 'accounts.get', () => ({}));

// @ts-expect-error operation mutation body must match the generated contract
createAccount.execute({ body: { name: 42 } });

// @ts-expect-error unknown stable operation ID
client.call('accounts.missing', {});

// @ts-expect-error binary download capabilities do not use the unary JSON client
client.call('reports.download', { params: { reportId: 'report-1' } });

// @ts-expect-error required path input is missing
client.call('accounts.get', { query: { include: ['owner'] } });

client.call('accounts.get', {
  params: { accountId: 'account-1' },
  // @ts-expect-error body is not an input location for this operation
  body: { name: 'wrong-location' },
});

client.call('accounts.create', {
  body: {
    // @ts-expect-error name must be a string
    name: 42,
  },
});

async function verifyStatusAndErrorNarrowing(): Promise<void> {
  const result: OperationResultOf<ContractFixture, 'accounts.get'> = await client.call(
    'accounts.get',
    { params: { accountId: 'account-1' } }
  );

  if (result.ok && result.notModified !== true) {
    const status: 200 = result.status;
    const ownerId: string | null = result.data.ownerId;
    void status;
    void ownerId;

    // @ts-expect-error accounts.get cannot return a 201 success
    const impossibleStatus: 201 = result.status;
    void impossibleStatus;
  } else if (!result.ok) {
    if (result.error.declared) {
      const code: 'AUTHENTICATION_ERROR' | 'ACCOUNT_NOT_FOUND' = result.error.code;
      void code;

      // @ts-expect-error CONFLICT is not declared for accounts.get
      const undeclaredCode: 'CONFLICT' = result.error.code;
      void undeclaredCode;
    } else {
      const versionSkewCode: string = result.error.code;
      void versionSkewCode;
    }
  }
}

void verifyStatusAndErrorNarrowing;
