import type { OperationRequestPolicy } from '@sixthsummit/ship-angular/operations';
import { createOperationUpload, type OperationUploadBinding } from './create-operation-upload';

interface Contract {
  readonly 'assets.upload': {
    readonly input: { readonly files: { readonly asset: File } };
    readonly success: { readonly 201: { readonly id: string } };
    readonly errors: 'INVALID_FILE';
    readonly transport: 'upload';
  };
  readonly 'assets.get': {
    readonly input: { readonly params: { readonly assetId: string } };
    readonly success: { readonly 200: { readonly id: string } };
    readonly errors: 'NOT_FOUND';
    readonly transport: 'http';
  };
}

declare const policy: OperationRequestPolicy<Contract>;
declare const binding: OperationUploadBinding<Contract, 'assets.upload'>;
declare const file: File;

const upload = createOperationUpload(policy, 'assets.upload', binding);
void upload.start({ files: { asset: file } });

// @ts-expect-error Unary operations cannot be passed to the upload capability.
createOperationUpload(policy, 'assets.get', binding);

// @ts-expect-error File input location and field are contract-derived.
void upload.start({ body: { asset: file } });
