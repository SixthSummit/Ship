import type { FixtureContract } from '@sixthsummit/ship-api-conformance-contract';
import type {
  HttpOperationId,
  OperationClient,
  OperationClientResult,
} from '@sixthsummit/ship-contract/client';

export type FixtureResultOf<TId extends HttpOperationId<FixtureContract>> = OperationClientResult<
  FixtureContract['operations'][TId]
>;

/** Synthetic runtime with the same client signature as ShipAPI's published client. */
export type FixtureClient = OperationClient<FixtureContract>;

export declare function createFixtureClient(options?: {
  readonly credentials?: RequestCredentials;
}): FixtureClient;
