import type {
  HttpOperationId,
  InputOf,
  OperationCallOptions,
  OperationClient,
} from '@sixthsummit/ship-angular/operations';
import type { ShipQueryEnvelope } from './ship-query-envelope';

/** Structural scope port. Final composition supplies the owned scope controller. */
interface ReadScopePort<TScope> {
  isCurrent(snapshot: TScope): boolean;
  signal(snapshot: TScope): AbortSignal;
}

/** The QueryClient supplies the previous envelope for the exact current key. */
export interface ExecuteReadOptions<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TScope,
> {
  readonly client: OperationClient<TContract>;
  readonly binding: {
    readonly operationId: TId;
    readonly safety: 'safe';
  };
  readonly input: InputOf<TContract, TId>;
  readonly call?: OperationCallOptions;
  readonly signal?: AbortSignal;
  readonly scope: TScope;
  readonly scopePort: ReadScopePort<TScope>;
  readonly previous?: ShipQueryEnvelope<TContract, TId>;
  /** Infinite queries disable conditional revalidation in v1. Defaults to true. */
  readonly etag?: boolean;
}
