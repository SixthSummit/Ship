/** Compile guard for the provider/resource pattern documented in OPERATION_CLIENT_GUIDE.md. */
import { InjectionToken, type Signal } from '@angular/core';
import {
  createOperationRequestPolicy,
  createOperationResource,
  createPolicyClientFromPolicy,
  createShipClientToken,
  type OperationClient,
  type OperationExecutor,
  type OperationPolicyMap,
  type OperationRequestPolicy,
  provideShipOperationBoundary,
} from '@sixthsummit/ship-angular/operations';
import type { FixtureContract } from '@sixthsummit/ship-api-conformance-contract';

declare const executor: OperationExecutor<FixtureContract>;
declare const accountId: Signal<string>;

const policies = {
  'accounts.get': operationPolicy('optional', 'safe'),
  'accounts.create': operationPolicy('required', 'unsafe', 'required'),
  'accounts.delete': operationPolicy('required', 'idempotent'),
  'public.status': operationPolicy('anonymous', 'safe'),
  'oauth.callback': operationPolicy('anonymous', 'safe'),
  'reports.download': operationPolicy('required', 'safe'),
  'assets.upload': operationPolicy('required', 'unsafe', 'required'),
  'events.watch': operationPolicy('optional', 'safe'),
  'agent.stream': operationPolicy('optional', 'safe'),
  'chat.socket': operationPolicy('required', 'safe'),
} satisfies OperationPolicyMap<FixtureContract>;

const APP_CLIENT = createShipClientToken<FixtureContract>('APP_CLIENT');
const APP_POLICY = new InjectionToken<OperationRequestPolicy<FixtureContract>>('APP_POLICY');

export const providers = provideShipOperationBoundary(
  APP_CLIENT,
  APP_POLICY,
  context => {
    const requestPolicy = createOperationRequestPolicy<FixtureContract>({
      policies,
      baseHeaders: context.forwardedHeaders,
      allowedOrigins: [new URL(context.apiBaseUrl).origin],
      credentials: { kind: 'anonymous' },
      requestId: { generate: () => 'request-documentation' },
    });
    return {
      requestPolicy,
      client: createPolicyClientFromPolicy(executor, requestPolicy, {
        targetUrl: context.apiBaseUrl,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    };
  },
  {
    apiBaseUrl: 'https://api.example.test',
    forwarding: { cookieNames: [], headerNames: ['x-request-id', 'accept-language'] },
  }
);

declare const client: OperationClient<FixtureContract>;
export const account = createOperationResource(client, 'accounts.get', () => ({
  params: { accountId: accountId() },
}));

function operationPolicy(
  authentication: 'anonymous' | 'optional' | 'required',
  safety: 'safe' | 'idempotent' | 'unsafe',
  idempotency: 'unsupported' | 'supported' | 'required' = 'unsupported'
) {
  return {
    authentication,
    safety,
    idempotency,
    replayable: true,
  } as const;
}
