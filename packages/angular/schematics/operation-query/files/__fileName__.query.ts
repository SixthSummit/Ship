import { inject, Injectable } from '@angular/core';
import type { InputOf, OperationClient } from '@sixthsummit/ship-angular/operations';
import {
  defineShipReadBinding,
  injectShipQuery,
  type ShipQueryContext,
  type ShipQueryEnvelope,
  type ShipQueryOptions,
} from '@sixthsummit/ship-angular/query';
import type { CreateQueryResult } from '@tanstack/angular-query-experimental';
import type { <%= contractType %> as QueryContract } from '<%= contractPackage %>';
import { <%= clientToken %> as QueryClientToken } from '<%= clientTokenImport %>';
import { <%= scopeSource %> as QueryContextToken } from '<%= scopeSourceImport %>';
import { <%= keyMapper %> as mapQueryInputKey } from '<%= keyMapperImport %>';
import { <%= variantKey %> as queryVariantKey } from '<%= variantKeyImport %>';

const OPERATION = '<%= operationId %>' as const;
const READ = defineShipReadBinding<QueryContract>()({
  operationId: OPERATION,
  safety: 'safe',
  inputKey: mapQueryInputKey,
  variantKey: queryVariantKey,
});

@Injectable({ providedIn: 'root' })
export class <%= name %>Query {
  private readonly client: OperationClient<QueryContract> = inject(QueryClientToken);
  private readonly context: ShipQueryContext = inject(QueryContextToken);

  /** Call in a component injection context. Read application signals inside the input factory. */
  create<TSelected = ShipQueryEnvelope<QueryContract, typeof OPERATION>>(
    input: () => InputOf<QueryContract, typeof OPERATION> | undefined,
    options:
      | ShipQueryOptions<QueryContract, typeof OPERATION, TSelected>
      | (() => ShipQueryOptions<QueryContract, typeof OPERATION, TSelected>) = {}
  ): CreateQueryResult<TSelected, Error> {
    return injectShipQuery(this.client, READ, input, this.context, options);
  }
}
