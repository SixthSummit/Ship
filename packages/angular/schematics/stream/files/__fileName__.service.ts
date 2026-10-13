import { Injectable } from '@angular/core';
import {
  createOperationStream,
  type OperationStream,
} from '@sixthsummit/ship-angular/stream';
import { <%= bindingName %> } from '<%= bindingPackage %>';
import type { <%= contractType %> } from '<%= contractPackage %>';
import { injectAppShipRequestPolicy } from '<%= apiImport %>';

const OPERATION = '<%= operationId %>' as const;

@Injectable({ providedIn: 'root' })
export class <%= name %>Service {
  private readonly policy = injectAppShipRequestPolicy();

  /** Explicitly call `start(input)`; service construction never opens a connection. */
  readonly stream: OperationStream<<%= contractType %>, typeof OPERATION> = createOperationStream(
    this.policy,
    OPERATION,
    <%= bindingName %>
  );
}
