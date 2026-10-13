import type { ResponseMetadata } from '@sixthsummit/ship-angular/operations';

/** A signed storage provider responded, but rejected the byte transfer. */
export class SignedUploadProviderError extends Error {
  readonly kind = 'signed-upload-provider' as const;
  readonly status: number;
  readonly headers: ResponseMetadata;

  constructor(status: number, headers: ResponseMetadata) {
    super('The signed upload provider rejected the transfer');
    this.name = 'SignedUploadProviderError';
    this.status = status;
    this.headers = headers;
  }
}
