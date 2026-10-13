import type { OperationRequestPolicy } from '@sixthsummit/ship-angular/operations';
import {
  createOperationDownload,
  type OperationDownloadBinding,
} from './create-operation-download';

interface Contract {
  readonly 'reports.download': {
    readonly input: { readonly params: { readonly reportId: string } };
    readonly success: { readonly 200: Uint8Array };
    readonly errors: 'NOT_FOUND';
    readonly transport: 'download';
  };
  readonly 'reports.get': {
    readonly input: { readonly params: { readonly reportId: string } };
    readonly success: { readonly 200: { readonly id: string } };
    readonly errors: 'NOT_FOUND';
    readonly transport: 'http';
  };
}

declare const policy: OperationRequestPolicy<Contract>;
declare const binding: OperationDownloadBinding<Contract, 'reports.download'>;

const download = createOperationDownload(policy, 'reports.download', binding, {
  representation: 'arrayBuffer',
});
void download.start({ params: { reportId: 'report-1' } });
const value: ArrayBuffer | undefined = download.value();
void value;

// @ts-expect-error Unary HTTP operations cannot be passed to the download capability.
createOperationDownload(policy, 'reports.get', binding, { representation: 'blob' });

// @ts-expect-error Input locations and fields come from the generated contract.
void download.start({ body: { reportId: 'report-1' } });
