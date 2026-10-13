import { Injectable } from '@angular/core';
import {
  type CreateOperationSignedUploadOptions,
  createOperationSignedUpload,
} from '@sixthsummit/ship-angular/upload';
import { <%= bindingName %> } from '<%= bindingPackage %>';
import { injectAppShipClient } from '<%= apiImport %>';

@Injectable({ providedIn: 'root' })
export class <%= name %>SignedUpload {
  private readonly client = injectAppShipClient();

  /** The caller owns the returned upload lifecycle and must call `destroy()`. */
  create(options: CreateOperationSignedUploadOptions) {
    return createOperationSignedUpload(this.client, <%= bindingName %>, options);
  }
}
