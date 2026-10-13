import type {
  OperationExecutor,
  OperationTypeContract,
} from '@sixthsummit/ship-angular/operations';
import { LegacyRestClientAdapter, type LegacyRestOperationBindings } from './public-api';

interface ContractFixture extends OperationTypeContract {
  readonly operations: {
    readonly 'accounts.get': {
      readonly transport: 'http';
      readonly input: { readonly params: { readonly accountId: string } };
      readonly result:
        | {
            readonly ok: true;
            readonly status: 200;
            readonly data: { readonly id: string };
          }
        | {
            readonly ok: false;
            readonly status: 404;
            readonly error: { readonly code: 'ACCOUNT_NOT_FOUND' };
          };
    };
    readonly 'reports.download': {
      readonly transport: 'download';
      readonly input: { readonly params: { readonly reportId: string } };
      readonly result:
        | { readonly ok: true; readonly status: 200; readonly data: Blob }
        | {
            readonly ok: false;
            readonly status: 404;
            readonly error: { readonly code: 'REPORT_NOT_FOUND' };
          };
    };
  };
}

const bindings = {
  'accounts.get': {
    invoke: async (_input, options) => {
      options.credentials satisfies RequestCredentials | undefined;
      options.attempt satisfies number | undefined;
      return Response.json({ id: 'account-1' });
    },
    declaredErrors: ['ACCOUNT_NOT_FOUND'],
    successStatuses: [200],
    decodeSuccess: (value: unknown) => value as { readonly id: string },
    cancellation: 'forwarded',
  },
} as const satisfies LegacyRestOperationBindings<ContractFixture>;

const client = new LegacyRestClientAdapter<ContractFixture>(bindings);
const executor: OperationExecutor<ContractFixture> = client;
void executor;

client.call('accounts.get', { params: { accountId: 'account-1' } });

// @ts-expect-error operation input remains contract-derived
client.call('accounts.get', { params: {} });

// @ts-expect-error binary operations use the download capability, not this unary adapter
client.call('reports.download', { params: { reportId: 'report-1' } });

const invalidBindings = {
  // @ts-expect-error non-HTTP operation mappings are rejected
  'reports.download': {
    invoke: async () => new Response(),
    declaredErrors: ['REPORT_NOT_FOUND'],
    successStatuses: [200],
    decodeSuccess: () => new Blob(),
    cancellation: 'discard-only',
  },
} satisfies LegacyRestOperationBindings<ContractFixture>;

void invalidBindings;
