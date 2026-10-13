# Backend integration during the redesign

The target ShipAPI integration is the structural operation client documented in
[`architecture/OPERATION_CLIENT_GUIDE.md`](architecture/OPERATION_CLIENT_GUIDE.md).

## Current choices

| Situation                       | Use                                                               |
| ------------------------------- | ----------------------------------------------------------------- |
| New ShipAPI work                | Packed contract/client plus `/operations`                         |
| Pinned ShipAPI v4 Hono site     | `/hono-v4` compatibility mapping, then migrate feature-by-feature |
| Pinned pre-Hono ShipAPI site    | `/legacy-rest` mapping for characterized JSON operations          |
| Third-party or non-ShipAPI REST | Root `ApiClient`/`createResource` and Angular `HttpClient` policy |

Do not install or type-import the ShipAPI runtime merely to obtain an application's types.
Do not create new `hc<typeof app>` integrations. The old pattern is preserved only in the
historical contract record and compatibility guide.

## Before the real ShipAPI artifact manifest lands

ShipAngular's local packed-conformance suite uses synthetic browser-only packages to prove its own
boundary, and that Angular-side implementation is complete. ShipAPI revision `059229c` now provides
the isolated `@sixthsummit/ship-contract` package, resolving the former server-monolith dependency
gap. It is not a substitute for ShipAPI's generated application artifact manifest. Until ShipAPI
provides that explicit manifest:

- develop framework APIs against the accepted structural interface;
- keep current sites pinned;
- do not hand-author a production application contract;
- do not claim joint conformance has passed.

Once available, run:

```bash
pnpm test:joint-conformance -- --manifest /path/to/shipapi-artifacts.json
```

The harness installs tarballs in a clean temporary consumer and rejects server dependency
leaks, invalid calls, runtime result loss, nondeterministic metadata, and optional skips.

## Migration sequence

1. Record the site's current version, auth, calls, SSR, and capability usage.
2. Install exact packed prerelease artifacts in a staging branch.
3. Establish the Hono mapping for untouched v4 calls or the legacy REST mapping for
   characterized pre-Hono URL calls if needed.
4. Move one read/mutation behavior at a time to stable operation IDs.
5. Run unit, browser, SSR, and telemetry checks.
6. Preserve the old pin and deploy artifact through the rollback window.

See the [client migration playbook](architecture/CLIENT_MIGRATION_PLAYBOOK.md) and
[operation-client ADR](architecture/decisions/0002-operation-client-contract.md).
