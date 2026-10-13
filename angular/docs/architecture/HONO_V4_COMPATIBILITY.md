# Hono v4 compatibility boundary

`@sixthsummit/ship-angular/hono-v4` is a temporary adapter for pinned applications that currently own an `hc<typeof app>` route-tree client. It lets supported legacy JSON endpoints drive the new `createOperationResource` and `createOperationMutation` surfaces without adding Hono to ShipAngular's operation kernel.

## Application-owned mapping

The application maps each stable operation ID to its existing Hono call:

```ts
import { HonoV4ClientAdapter } from '@sixthsummit/ship-angular/hono-v4';
import type { AppContract } from '@company/app-contract';
import { api } from './legacy-api';

export const client = new HonoV4ClientAdapter<AppContract>({
  'accounts.get': {
    invoke: ({ params }, options) =>
      api.accounts[':accountId'].$get(
        { param: params },
        { init: { signal: options.signal, headers: options.headers } }
      ),
    declaredErrors: ['AUTHENTICATION_ERROR', 'ACCOUNT_NOT_FOUND'],
    successStatuses: [200],
    decodeSuccess: value => AccountViewSchema.parse(value),
    cancellation: 'forwarded',
  },
});
```

The mapping is deliberately explicit. It is the only place that knows Hono route properties, legacy parameter names, or `ClientResponse`. The adapter itself has no Hono dependency.

## Supported behavior

- JSON success responses and bodyless `204` responses;
- standard ShipAPI JSON error envelopes, including unknown future codes;
- status and browser-readable response metadata;
- `304` cache revalidation for operation resources;
- forwarded cancellation when the Hono invocation accepts `signal`; and
- discard-only cancellation when a legacy call cannot stop its underlying request.

## Intentional limitations

- Every endpoint needs a stable-ID mapping and a client-safe success decoder.
- Unexpected success statuses fail instead of being silently cast.
- Uploads, downloads, streams, and sockets use their dedicated operation capabilities.
- `discard-only` prevents stale UI publication but may leave legacy network work running.
- Retry, auth, CSRF, request-ID, and idempotency policy must wrap the resulting structural client; the mapping must not recreate a second policy system.

Applications can query `adapter.compatibility(operationId)` to report missing mappings and cancellation quality during migration. Missing mappings fail with `HonoV4CompatibilityError`, not a property-access accident from the route tree.

## Removal gate

The entrypoint remains isolated and temporary. It can be removed only after every active pinned site has a recorded migration disposition, upgraded sites no longer import it, production observation and rollback windows have closed, and a separate breaking-release decision is approved.
