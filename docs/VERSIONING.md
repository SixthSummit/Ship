# Versioning and deprecation contract

ShipAPI publishes a tested set of focused packages plus the
`@sixthsummit/ship-api` v4 compatibility distribution. Versions are managed by
Changesets. The mechanics live in [RELEASING.md](./RELEASING.md); the stability
tiers live in [PUBLIC_API_SURFACE.md](./PUBLIC_API_SURFACE.md).

## Package versions and release manifests

Each package has an independent version. A release is one reviewed manifest of
exact package versions, packed hashes, dependency closures, and verification
results. Equal version numbers across packages would not prove compatibility,
so the repository does not force them into lockstep.

Consumers pin each direct Ship dependency exactly and commit their lockfile:

```json
{
  "dependencies": {
    "@sixthsummit/ship-core": "1.2.1",
    "@sixthsummit/ship-hono": "1.1.0",
    "@sixthsummit/ship-contract": "1.3.0"
  }
}
```

Do not use a caret, moving prerelease tag, branch, commit, or workspace link for
a protected consumer candidate. The framework team owns version-bump PRs and
consumer upgrade PRs; application teams approve their behavior and deployment.

## SemVer by owned surface

Once a focused package reaches stable `1.0.0`, changes are classified against
the exports and behavior it owns:

- **Major:** removes or incompatibly changes a documented export, operation or
  manifest shape, stable diagnostic/error code, wire contract, transaction or
  access guarantee, or another behavior in the public-surface document.
- **Minor:** adds a backward-compatible export, optional field, operation
  capability, adapter option, or deprecation.
- **Patch:** restores documented behavior without changing the contract.

The v4 compatibility distribution follows normal v4 SemVer. Breaking its
contract-tier barrel or `/client` surface requires v5 after the deprecation
window. Other legacy deep paths are reach-through and may change in a v4 minor,
but migration notes must call out known consumers.

Dependency majors are breaking when dependency types or runtime behavior cross
the package's public boundary. Hono changes are owned by `ship-hono`; Drizzle
changes are owned by `ship-drizzle`. They do not force a kernel major unless the
kernel contract itself changes.

## Shared runtimes are peer dependencies

A focused package declares a third-party runtime as a **peer dependency** when
the application also imports that runtime and the two must agree on one copy:
the package consumes or returns instances whose types or runtime identity cross
the public boundary. It keeps the runtime as a regular dependency when the
package fully encapsulates it.

| Runtime | Package | Declared as | Why |
| --- | --- | --- | --- |
| `hono` | `ship-hono` | peer | the app mounts middleware and extra routes on the same `Hono` |
| `drizzle-orm` | `ship-drizzle`, `ship-testing` | peer | the app defines its schema and receives `NodePgDatabase` instances |
| `ioredis` | `ship-jobs-bullmq`, `ship-realtime-socketio` | peer | the app constructs the client it passes in |
| `socket.io` | `ship-realtime-socketio` | regular | the gateway creates the server; the app passes an `http.Server` and options |
| `bullmq` | `ship-jobs-bullmq` | regular | queues and workers are created inside the backend |
| Redis client | `ship-cache-redis` | none | the backend takes a structural client; no driver is imported |

Each peer range is a caret range, and the package keeps the same range in its
`devDependencies` for its own tests. The `@sixthsummit/ship-api` compatibility
distribution keeps regular dependencies because compat consumers do not mount
their own Hono.

Consumers pin Ship packages exactly and declare the shared runtime with the
peer's caret range, never an exact pin: the `ship-api create` scaffold writes
that shape, the golden consumers carry it, and the packed-consumer gate fails
when a clean install resolves more than one copy of `hono` or `drizzle-orm`.

## What is not a breaking change

- internal files not reachable through a package `exports` map;
- private helpers and implementation layout;
- additive graph/manifest/error fields that consumers are required to preserve
  or ignore;
- safe human-message improvements with stable code, status, and meaning;
- log text and other non-contracted observability details; and
- implementation-only dependency changes whose types and behavior do not cross
  the public boundary.

## Deprecation policy

Nothing contract-tier disappears silently.

1. Deprecate it in a minor. Keep it working, mark it in declarations, document
   the replacement, and add migration guidance.
2. Ship at least one later minor while the deprecated surface still works.
3. Remove it only in the next major, with a codemod for mechanical changes or
   explicit manual steps where automation is unsafe.

The Hono `hc<typeof app>` seam and route-first APIs remain supported through v4.
The structural operation client is the target for new work. Any `hc()`
deprecation begins in a v4 minor and removal is no earlier than v5.

## Breaking-change evidence

Every breaking change includes:

- a Changeset naming each affected package;
- a `BREAKING CHANGE` explanation and old/new examples;
- migration automation or a reason automation would be unsafe;
- packed old/new consumer type and runtime fixtures;
- behavior/parity evidence for affected clients; and
- a rollback or forward-fix plan.

Do not bundle unrelated breaks into one migration merely because they share a
major release number.

## Development snapshots

Stable package versions and changelogs are committed by the release workflow on
`main` and merged back into `dev`. Pending Changesets on `dev` produce timestamped
`alpha` snapshots without changing the source versions. Changesets pre mode is
retired. Treat snapshots as prereleases and pin stable versions for production
unless a separately reviewed adoption plan requires a snapshot.

The first stable releases established the guarantees above. Historical v4 GA
adoption gates remain recorded in ADR 0012; each application still owns its
migration, deployment, and rollback approval.
