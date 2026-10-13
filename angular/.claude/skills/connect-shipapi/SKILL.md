---
name: connect-shipapi
description: Use when connecting a ShipAngular application to ShipAPI through its packed browser-safe contract and operation client. Covers structural client DI, browser and SSR request scope, authentication capabilities, operation resources, and conformance checks.
---

# Connect ShipAngular to ShipAPI operations

Use the generated browser-safe application contract and ShipAPI client runtime. Never
import a composed Hono application, ShipAPI server/root runtime, database schema, or server
module into the Angular application. The current `/contract` subpath is transitional until
ShipAPI publishes its separately packable browser client.

## Pre-flight

- Identify the published or packed contract package and exported contract type.
- Identify the browser-safe client factory supplied by ShipAPI.
- Confirm the contract hash/version expected by the application.
- Choose bearer or cookie-session authentication deliberately.
- For SSR, list the exact cookie and header names approved for forwarding.

Do not use source/workspace links as integration proof. During coordinated local work,
install tarballs produced by each repository's pack command.

## Generate the Angular boundary

```bash
pnpm exec ng generate @sixthsummit/ship-angular:api-client \
  --contractPackage=@my-org/ship-api-contract \
  --contractType=AppContract
```

The generated `src/api.ts` owns application-specific client and request-policy tokens.
Supply one boundary factory at app configuration time:

```ts
import { clientContract, type AppContract } from '@my-org/ship-api-contract';
import { createHttpOperationClient } from '@sixthsummit/ship-api/contract';
import {
  createOperationRequestPolicy,
  createPolicyClientFromPolicy,
} from '@sixthsummit/ship-angular/operations';
import { createShipApiClientExecutor } from '@sixthsummit/ship-angular/ship-api';
import { provideAppShipClient } from './api';
import { operationPolicies } from './operation-policies';

provideAppShipClient(context => {
  const requestPolicy = createOperationRequestPolicy({
    policies: operationPolicies,
    baseHeaders: context.forwardedHeaders,
    allowedOrigins: [new URL(context.apiBaseUrl).origin],
    credentials: currentCredentialCapability,
  });
  const executor = createShipApiClientExecutor<AppContract>(clientContract, ({ credentials }) =>
    createHttpOperationClient<AppContract>(clientContract, {
      baseUrl: context.apiBaseUrl,
      fetch: globalThis.fetch,
      credentials,
    })
  );
  return {
    requestPolicy,
    client: createPolicyClientFromPolicy(executor, requestPolicy, {
      targetUrl: context.apiBaseUrl,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }),
  };
});
```

Once the boundary compiles against the packed contract, prefer the explicit operation
generators for app-owned wrappers:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:operation-resource account-detail \
  --operationId=accounts.get
pnpm exec ng generate @sixthsummit/ship-angular:operation-mutation create-account \
  --operationId=accounts.create
pnpm exec ng generate @sixthsummit/ship-angular:operation-auth app \
  --meOperationId=auth.me --signInOperationId=auth.login \
  --signOutOperationId=auth.logout --refreshOperationId=auth.refresh
```

The generated resource takes a signal-tracked input factory. The generated mutation keeps
declared failures as values. Neither generator invents transport metadata or error handling.
The generated session-auth factory accepts an application-owned `mapUser` decoder and keeps
operation selection explicit; do not replace that decoder with `as AuthUser`.

For generated non-JSON and form bindings, use the matching `:download`, `:socket`, `:stream`,
`:upload`, `:signed-upload`, or `:operation-form` schematic. Pass exact socket/provider origin
allowlists when creating those state machines; do not add wildcard or credential-bearing URLs.

Until ShipAPI projects operation request policy, `operationPolicies` is an
application-owned, fully typed map reviewed against the backend declarations. Never infer
unsafe retry permission from an HTTP method.

The factory is invoked once per Angular injector. In SSR it receives only allowlisted
cookies and headers; it must never cache one request's credentials in a process singleton.

## Authentication and request policy

Attach credentials through operation-client capabilities:

- bearer providers read the current token for each call;
- cookie sessions use the configured browser credentials mode;
- CSRF is enabled only for the selected cookie-session contract;
- request IDs, idempotency, timeout, cancellation, and safe retries live in the same
  operation transport pipeline;
- never retry an unsafe operation unless its contract declares idempotency support.

Angular `HttpClient` interceptors remain appropriate for unrelated third-party REST. Do
not reproduce operation-client policy in both interceptors and fetch wrappers.

## Read and mutate data

Use stable operation IDs and contract-owned input locations:

```ts
import { createOperationResource } from '@sixthsummit/ship-angular/operations';
import { injectAppShipClient } from '../../api';

readonly client = injectAppShipClient();
readonly account = createOperationResource(
  this.client,
  'accounts.get',
  () => ({ params: { accountId: this.accountId() } }),
);
```

For mutations call `client.call(operationId, input, options)`. Declared API failures are
`{ ok: false }` values; switch on `result.error.code`. Network failures, cancellation,
malformed responses, and programmer errors remain exceptional.

Use explicit `/upload`, `/download`, `/stream`, and `/socket` entrypoints only when the
operation declares that capability. Do not coerce them through the JSON unary result.

## Verify

- `pnpm type-check`
- `pnpm test`
- application browser tests for auth, cancellation, and request IDs
- SSR concurrency test when SSR is enabled
- compare the installed contract hash/version with the backend artifact

Framework maintainers additionally run `pnpm test:packed-conformance` and
`pnpm test:browser-conformance`. When the paired
ShipAPI artifacts exist, run `pnpm test:joint-conformance -- --manifest <path>`.

## Legacy Hono applications

Pinned v4 applications may temporarily map legacy calls through
`@sixthsummit/ship-angular/hono-v4`. Keep all route-tree knowledge in that mapping and
follow the `migrate-hono-to-operations` skill. Do not use the adapter for new features.

## See also

- `docs/architecture/decisions/0002-operation-client-contract.md`
- `docs/architecture/OPERATION_CLIENT_GUIDE.md`
- `docs/architecture/HONO_V4_COMPATIBILITY.md`
- `docs/architecture/JOINT_CONFORMANCE_PLAN.md`
