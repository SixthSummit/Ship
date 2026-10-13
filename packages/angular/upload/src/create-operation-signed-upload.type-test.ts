import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import {
  createOperationSignedUpload,
  type OperationSignedUploadBinding,
} from './create-operation-signed-upload';

interface Contract {
  readonly 'assets.sign': {
    readonly input: { readonly body: { readonly name: string } };
    readonly success: { readonly 201: { readonly url: string } };
    readonly errors: 'DENIED';
    readonly transport: 'http';
  };
  readonly 'assets.complete': {
    readonly input: { readonly body: { readonly status: number } };
    readonly success: { readonly 200: { readonly id: string } };
    readonly errors: 'REJECTED';
    readonly transport: 'http';
  };
  readonly 'assets.upload': {
    readonly input: { readonly files: { readonly asset: File } };
    readonly success: { readonly 201: { readonly id: string } };
    readonly errors: 'INVALID';
    readonly transport: 'upload';
  };
}

declare const client: OperationClient<Contract>;
declare const binding: OperationSignedUploadBinding<Contract, 'assets.sign', 'assets.complete'>;
declare const file: File;

const upload = createOperationSignedUpload(client, binding, {
  allowedProviderOrigins: ['https://storage.example.test'],
});
void upload.start(file, {
  sign: { headers: { 'x-locale': 'en' } },
  complete: { idempotencyKey: 'completion-key' },
});

// @ts-expect-error Upload capability IDs cannot be used as unary signing operations.
const invalidBinding: OperationSignedUploadBinding<Contract, 'assets.upload'> = binding;
void invalidBinding;
