import { Injectable } from '@angular/core';
import {
  type CreateOperationResourceOptions,
  createOperationResource,
  type InputOf,
  type OperationResource,
} from '@sixthsummit/ship-angular/operations';
import type { <%= contractType %> } from '<%= contractPackage %>';
import { injectAppShipClient } from '<%= apiImport %>';

const OPERATION = '<%= operationId %>' as const;

@Injectable({ providedIn: 'root' })
export class <%= name %>Resource {
  private readonly client = injectAppShipClient();

  create(
    input: () => InputOf<<%= contractType %>, typeof OPERATION> | undefined,
    options: CreateOperationResourceOptions<<%= contractType %>, typeof OPERATION> = {}
  ): OperationResource<<%= contractType %>, typeof OPERATION> {
    return createOperationResource(this.client, OPERATION, input, options);
  }
}
