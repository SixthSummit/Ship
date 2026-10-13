import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import type { FixtureContract } from '@sixthsummit/ship-api-conformance-contract';

declare const client: OperationClient<FixtureContract>;

// @ts-expect-error unknown stable operation ID
client.call('accounts.missing', {});

// @ts-expect-error required path input is missing
client.call('accounts.get', { query: { include: ['owner'] } });

client.call('accounts.get', {
  params: { accountId: 'account-1' },
  // @ts-expect-error body is not accepted by this operation
  body: { name: 'wrong-location' },
});

client.call('accounts.create', {
  body: {
    // @ts-expect-error generated body fields retain their types
    name: 42,
  },
});

// @ts-expect-error download capabilities cannot use the unary JSON client
client.call('reports.download', { params: { reportId: 'report-1' } });

async function narrowResult(): Promise<void> {
  const result = await client.call('accounts.get', { params: { accountId: 'account-1' } });
  if (result.ok) {
    // @ts-expect-error accounts.get cannot return a 201 success
    const impossibleStatus: 201 = result.status;
    void impossibleStatus;
  } else if (result.error.declared) {
    // @ts-expect-error CONFLICT is not declared for accounts.get
    const impossibleCode: 'CONFLICT' = result.error.code;
    void impossibleCode;
  }
}

void narrowResult;
