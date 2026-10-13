import { Injectable } from '@angular/core';
import {
  createOperationMutation,
  type OperationMutation,
} from '@sixthsummit/ship-angular/operations';
import type { <%= contractType %> } from '<%= contractPackage %>';
import { injectAppShipClient } from '<%= apiImport %>';

const OPERATION = '<%= operationId %>' as const;

@Injectable({ providedIn: 'root' })
export class <%= name %>Mutation {
  private readonly client = injectAppShipClient();

  readonly mutation: OperationMutation<<%= contractType %>, typeof OPERATION> =
    createOperationMutation(this.client, OPERATION);
}
