# @sixthsummit/ship-angular

Frontend-only Angular 20 framework for signal-first applications and ShipAPI's
operation-centric application kernel. Stable releases come from `main`; development
snapshots come from `dev`. See `CHANGELOG.md` for released changes.

## ShipAPI operations

Applications install a generated browser-safe contract and structural client. ShipAngular
owns Angular dependency injection, signals/resources, SSR request scope, and UI-facing
adaptation:

```ts
import { createOperationResource } from '@sixthsummit/ship-angular/operations';
import { injectAppShipClient } from './api';

const client = injectAppShipClient();
const account = createOperationResource(client, 'accounts.get', () => ({
  params: { accountId: accountId() },
}));
```

Declared API errors remain typed result values. Network, cancellation, timeout, malformed
response, protocol, and programmer failures remain exceptional.

## Secondary entrypoints

- `/query` — optional TanStack Query reads, mutations, cache identity, and SSR hydration
- `/realtime` — manifest-declared subscriptions and presence
- `/operations` — unary client kernel, request policy, DI, resources, and mutations
- `/ship-api` — adapter for ShipAPI's browser-safe structural client and manifest
- `/auth` — operation-backed session authentication
- `/firebase-auth` — optional Firebase frontend authentication adapter
- `/forms` — operation input forms and browser-safe codecs
- `/upload`, `/download`, `/stream`, `/socket` — explicit transport capabilities
- `/testing` — runner-independent conformance utilities
- `/eslint` — framework semantic rules for consumer applications
- `/hono-v4` — temporary compatibility for pinned Hono applications
- `/legacy-rest` — temporary operation bridge for pinned URL-based REST applications

The root entrypoint retains general Angular/auth/REST APIs for current consumers and
third-party REST. New ShipAPI work should not use root Hono thunks or duplicate fetch
wrappers.

The `/query` entrypoint is pending release on `dev` and is not in the previously
released 4.1.0 package.

## Schematics

```bash
pnpm exec ng generate @sixthsummit/ship-angular:api-client \
  --contractPackage=@my-org/ship-api-contract \
  --contractType=AppContract
pnpm exec ng generate @sixthsummit/ship-angular:operation-resource account \
  --operationId=accounts.get
pnpm exec ng generate @sixthsummit/ship-angular:operation-mutation create-account \
  --operationId=accounts.create
pnpm exec ng generate @sixthsummit/ship-angular:download invoice \
  --operationId=invoices.pdf --bindingName=invoiceDownloadBinding

pnpm exec ng generate @sixthsummit/ship-angular:module orders
pnpm exec ng generate @sixthsummit/ship-angular:page orders detail
```

Features are app-owned under `src/app/modules`; no copied framework catalog is published.

## Requirements

- Published library: Node.js 20 or newer; repository tooling uses the Node version in `.nvmrc`
- Angular 20
- pnpm for this repository; consuming applications may use another package manager

See the repository's operation guide, ADRs, compatibility guide, and packed conformance
plan before integrating the framework.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
