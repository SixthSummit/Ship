import {
  InjectionToken,
  inject,
  PendingTasks,
  PLATFORM_ID,
  type Provider,
  REQUEST,
} from '@angular/core';
import type { OperationRequestPolicy } from './create-operation-request-policy';
import { createPendingTaskClient } from './create-pending-task-client';
import type { OperationClient } from './operation-client';
import {
  createShipClientContext,
  type ShipClientContext,
  type ShipClientContextConfig,
} from './ship-client-context';

/** One request-scoped client and the policy shared by every operation transport. */
export interface ShipOperationBoundary<TContract extends object> {
  readonly client: OperationClient<TContract>;
  readonly requestPolicy: OperationRequestPolicy<TContract>;
}

export type ShipOperationBoundaryFactory<TContract extends object> = (
  context: ShipClientContext
) => ShipOperationBoundary<TContract>;

export interface ShipOperationBoundaryConfig extends ShipClientContextConfig {
  /**
   * Register an Angular `PendingTasks` task for the whole duration of every unary operation
   * call, including retries, so `ApplicationRef.whenStable()`, SSR, hydration, and test harnesses
   * wait for in-flight operations exactly as they wait for `HttpClient`. Default: `true`.
   */
  readonly trackPendingTasks?: boolean;
}

/**
 * Provide a request-scoped operation client and transport policy from one factory.
 *
 * The factory runs once per Angular injector. Unary calls, uploads, downloads, streams,
 * and sockets can therefore share current credentials and sanitized SSR context without
 * retaining another request's state.
 */
export function provideShipOperationBoundary<TContract extends object>(
  clientToken: InjectionToken<OperationClient<TContract>>,
  policyToken: InjectionToken<OperationRequestPolicy<TContract>>,
  factory: ShipOperationBoundaryFactory<TContract>,
  config: ShipOperationBoundaryConfig
): readonly Provider[] {
  const boundaryToken = new InjectionToken<ShipOperationBoundary<TContract>>(
    `${clientToken.toString()}_BOUNDARY`
  );

  return [
    {
      provide: boundaryToken,
      useFactory: (): ShipOperationBoundary<TContract> => {
        const boundary = factory(
          createShipClientContext(
            inject(PLATFORM_ID),
            inject(REQUEST, { optional: true }) ?? null,
            config
          )
        );
        return config.trackPendingTasks === false
          ? boundary
          : { ...boundary, client: createPendingTaskClient(boundary.client, inject(PendingTasks)) };
      },
    },
    {
      provide: clientToken,
      useFactory: () => inject(boundaryToken).client,
    },
    {
      provide: policyToken,
      useFactory: () => inject(boundaryToken).requestPolicy,
    },
  ];
}
