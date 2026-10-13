import { Injectable } from '@angular/core';
import {
  type CreateOperationSocketOptions,
  createOperationSocket,
} from '@sixthsummit/ship-angular/socket';
import { <%= bindingName %> } from '<%= bindingPackage %>';
import { injectAppShipClient } from '<%= apiImport %>';

@Injectable({ providedIn: 'root' })
export class <%= name %>Socket {
  private readonly client = injectAppShipClient();

  /** The caller owns the returned socket lifecycle and must call `destroy()`. */
  create(options: CreateOperationSocketOptions) {
    return createOperationSocket(this.client, <%= bindingName %>, options);
  }
}
