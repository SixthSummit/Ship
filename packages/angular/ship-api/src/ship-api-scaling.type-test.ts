import { type OperationResultOf } from '@sixthsummit/ship-angular/operations';
import {
  createShipApiClientExecutor,
  type ShipApiClientContractManifest,
} from '@sixthsummit/ship-angular/ship-api';
import { createHttpOperationClient } from '@sixthsummit/ship-contract/client';
import type { ClientContract } from '@sixthsummit/ship-contract/manifest';

type ReadRoute<TId extends string> = {
  readonly transport: 'http';
  readonly input: { readonly params: { readonly id: TId } };
  readonly result:
    | { readonly ok: true; readonly status: 200; readonly data: { readonly id: TId } }
    | {
        readonly ok: false;
        readonly status: 404;
        readonly error: { readonly code: 'NOT_FOUND'; readonly message: string };
      };
};

type WriteRoute<TId extends string> = {
  readonly transport: 'http';
  readonly input: { readonly body: { readonly id: TId; readonly value: string } };
  readonly result:
    | { readonly ok: true; readonly status: 201; readonly data: { readonly saved: TId } }
    | {
        readonly ok: false;
        readonly status: 409;
        readonly error: { readonly code: 'CONFLICT'; readonly message: string };
      };
};

/** Synthetic operations exercise the shared generic call boundary at scale. */
interface ScaledContract {
  readonly operations: {
    readonly 'accounts.read01': ReadRoute<'01'>;
    readonly 'accounts.write01': WriteRoute<'01'>;
    readonly 'accounts.read02': ReadRoute<'02'>;
    readonly 'accounts.write02': WriteRoute<'02'>;
    readonly 'accounts.read03': ReadRoute<'03'>;
    readonly 'accounts.write03': WriteRoute<'03'>;
    readonly 'accounts.read04': ReadRoute<'04'>;
    readonly 'accounts.write04': WriteRoute<'04'>;
    readonly 'accounts.read05': ReadRoute<'05'>;
    readonly 'accounts.write05': WriteRoute<'05'>;
    readonly 'accounts.read06': ReadRoute<'06'>;
    readonly 'accounts.write06': WriteRoute<'06'>;
    readonly 'accounts.read07': ReadRoute<'07'>;
    readonly 'accounts.write07': WriteRoute<'07'>;
    readonly 'accounts.read08': ReadRoute<'08'>;
    readonly 'accounts.write08': WriteRoute<'08'>;
    readonly 'accounts.read09': ReadRoute<'09'>;
    readonly 'accounts.write09': WriteRoute<'09'>;
    readonly 'accounts.read10': ReadRoute<'10'>;
    readonly 'accounts.write10': WriteRoute<'10'>;
    readonly 'accounts.read11': ReadRoute<'11'>;
    readonly 'accounts.write11': WriteRoute<'11'>;
    readonly 'accounts.read12': ReadRoute<'12'>;
    readonly 'accounts.write12': WriteRoute<'12'>;
    readonly 'accounts.read13': ReadRoute<'13'>;
    readonly 'accounts.write13': WriteRoute<'13'>;
    readonly 'accounts.read14': ReadRoute<'14'>;
    readonly 'accounts.write14': WriteRoute<'14'>;
    readonly 'accounts.read15': ReadRoute<'15'>;
    readonly 'accounts.write15': WriteRoute<'15'>;
    readonly 'accounts.read16': ReadRoute<'16'>;
    readonly 'accounts.write16': WriteRoute<'16'>;
  };
}

declare const apiManifest: ClientContract;
declare const angularManifest: ShipApiClientContractManifest;

const apiClient = createHttpOperationClient<ScaledContract>(apiManifest, {
  baseUrl: 'https://example.test',
});
const executor = createShipApiClientExecutor<ScaledContract>(angularManifest, () => apiClient);
const read: Promise<OperationResultOf<ScaledContract, 'accounts.read01'>> = executor.call(
  'accounts.read01',
  { params: { id: '01' } },
  { signal: new AbortController().signal, attempt: 1 }
);
void read;

apiClient.call('accounts.read01', { params: { id: '01' } });
apiClient.call('accounts.write01', { body: { id: '01', value: 'saved' } });

// @ts-expect-error unknown operation ID
apiClient.call('accounts.missing', { params: { id: '01' } });
// @ts-expect-error wrong input location in an object literal
apiClient.call('accounts.read01', { body: { id: '01' } });
const extraLocation = { params: { id: '01' as const }, body: { id: '01' as const } };
// @ts-expect-error wrong input location in a pretyped variable
apiClient.call('accounts.read01', extraLocation);
// @ts-expect-error wrong route-specific ID
apiClient.call('accounts.read02', { params: { id: '01' } });

async function narrowResult(): Promise<void> {
  const result = await apiClient.call('accounts.read01', { params: { id: '01' } });
  if (result.ok) {
    const status: 200 = result.status;
    const id: '01' = result.data.id;
    void status;
    void id;
  } else if (result.status === 404) {
    const code: 'NOT_FOUND' = result.error.code;
    void code;
  }
}
void narrowResult;
