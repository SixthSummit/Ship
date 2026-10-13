# Legacy REST compatibility boundary

`@sixthsummit/ship-angular/legacy-rest` is a temporary bridge for pinned applications
that use hand-written URL clients and predate the Hono v4 integration. The adapter
lets one characterized JSON operation at a
time use the target resource, mutation, error, metadata, and request-policy semantics.

## Application-owned mapping

The application maps a stable operation ID to its existing URL, method, and wire shape.
The mapping must return a native `Response`; a legacy helper that has already reduced the
response to `Promise<T>` or a message-only exception has already discarded information
the adapter cannot recover.

```ts
import { LegacyRestClientAdapter } from '@sixthsummit/ship-angular/legacy-rest';
import { createPolicyClient, type OperationPolicyMap } from '@sixthsummit/ship-angular/operations';
import type { AppContract } from '@company/app-contract';
import { AccountViewSchema } from '@company/app-contract/schemas';
import { environment } from '../environments/environment';

const adapter = new LegacyRestClientAdapter<AppContract>({
  'accounts.get': {
    invoke: ({ params }, options) =>
      fetch(`${environment.apiOrigin}/v1/accounts/${encodeURIComponent(params.accountId)}`, {
        method: 'GET',
        headers: options.headers,
        credentials: options.credentials,
        signal: options.signal,
      }),
    declaredErrors: ['AUTHENTICATION_ERROR', 'ACCOUNT_NOT_FOUND'],
    successStatuses: [200],
    decodeSuccess: value => AccountViewSchema.parse(value),
    cancellation: 'forwarded',
  },
});

declare const policies: OperationPolicyMap<AppContract>;

export const client = createPolicyClient(adapter, {
  policies,
  targetUrl: environment.apiOrigin,
  allowedOrigins: [environment.apiOrigin],
  credentials: {
    kind: 'bearer',
    getToken: async () => currentFirebaseToken(),
  },
});
```

The shared policy client, not the mapping, owns credential refresh, request IDs, CSRF,
idempotency, timeout, and retry decisions. The mapping applies the prepared headers,
credentials mode, and signal to the temporary request.

## Supported behavior

- JSON success and standard ShipAPI JSON error envelopes;
- bodyless `204` and cache-revalidation `304` responses;
- declared and unknown error codes without message parsing;
- response status, request ID, retry, ETag, content type, and disposition metadata;
- shared bearer/cookie/CSRF/request-ID/idempotency policy when wrapped by
  `createPolicyClient`; and
- forwarded or explicitly discard-only cancellation.

## Intentional limits

- URL construction and input serialization stay in the application mapping; this is not
  a second generated client.
- Every mapped success needs a browser-safe decoder and explicit success/error allowlist.
- A mapping cannot call the old message-only client and regain lost status, headers, or
  structured errors.
- Multipart upload, binary download, stream, and socket operations use their dedicated
  entrypoints.
- `discard-only` prevents late UI publication but does not stop underlying network work.
- New APIs must target the generated ShipAPI client rather than adding legacy mappings.

## Migration sequence

1. Add characterization tests for one domain and classify every mutation's retry safety.
2. Replace that domain's copied-client calls with stable operation mappings returning
   `Response`.
3. Wrap the adapter with the shared policy and move components to operation resources or
   mutations.
4. Move multipart and PDF paths to `/upload` and `/download` independently.
5. Replace mappings with the generated ShipAPI client as matching operations become
   available, then delete the mapping.

The entrypoint follows the same removal gate as `/hono-v4`: no active upgraded client may
import it, all production observation windows must be closed, and removal requires a
separate explicit breaking release.
