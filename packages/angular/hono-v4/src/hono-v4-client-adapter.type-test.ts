import { HonoV4ClientAdapter, type HonoV4OperationBindings } from './public-api';

interface ContractFixture {
  readonly 'accounts.get': {
    readonly input: { readonly params: { readonly accountId: string } };
    readonly success: { readonly 200: { readonly id: string } };
    readonly errors: 'ACCOUNT_NOT_FOUND';
    readonly transport: 'http';
  };
  readonly 'reports.download': {
    readonly input: { readonly params: { readonly reportId: string } };
    readonly success: { readonly 200: Blob };
    readonly errors: 'REPORT_NOT_FOUND';
    readonly transport: 'download';
  };
}

const bindings = {
  'accounts.get': {
    invoke: async () => Response.json({ id: 'account-1' }),
    declaredErrors: ['ACCOUNT_NOT_FOUND'],
    successStatuses: [200],
    decodeSuccess: (value: unknown) => value as { readonly id: string },
    cancellation: 'forwarded',
  },
} as const satisfies HonoV4OperationBindings<ContractFixture>;

const client = new HonoV4ClientAdapter<ContractFixture>(bindings);
client.call('accounts.get', { params: { accountId: 'account-1' } });

// @ts-expect-error route-tree mapping does not weaken the operation input contract
client.call('accounts.get', { params: {} });

// @ts-expect-error non-JSON transports require their dedicated capability adapter
client.call('reports.download', { params: { reportId: 'report-1' } });

const invalidBindings = {
  // @ts-expect-error download capabilities cannot be installed in the unary Hono adapter
  'reports.download': {
    invoke: async () => new Response(),
    declaredErrors: ['REPORT_NOT_FOUND'],
    successStatuses: [200],
    decodeSuccess: () => new Blob(),
    cancellation: 'discard-only',
  },
} satisfies HonoV4OperationBindings<ContractFixture>;

void invalidBindings;
