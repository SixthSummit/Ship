# ShipAngular client migration playbook

> Company client sites are pinned to ShipAngular versions. Pins prevent accidental rollout, but every site still requires an owned, observable, reversible migration to the operation-client architecture.

## Objectives

- discover actual usage before compatibility behavior is finalized;
- preserve each site's current production pin until its migration is approved;
- upgrade in cohorts with a canary first;
- automate mechanical changes and document manual decisions;
- verify staging and production behavior with site-specific tests; and
- retain a tested rollback path until the observation window closes.

## Site inventory

Create one record per application. Record application-owned evidence rather than relying on package download counts.

Keep each application's migration record in its own repository, outside the framework documentation.

| Field             | Required detail                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Site/application  | Repository, deployment, business owner, engineering owner                                  |
| Current pin       | Exact ShipAngular version, lockfile integrity, registry artifact availability              |
| ShipAPI pairing   | ShipAPI version/branch/deployment and current contract assumptions                         |
| Data access       | `ApiClient`, URL `createResource`, Hono thunk resources, direct `hc`, raw fetch/HttpClient |
| Auth              | Firebase bearer, cookie session, custom adapter, CSRF, refresh, SSR forwarding             |
| Capabilities      | Upload, signed upload, download, SSE/chunk stream, WebSocket, online/health                |
| Forms             | Zod/Drizzle/server schema imports, custom validators, omitted/null conventions             |
| Modules           | Copied ShipAngular modules and local modifications/ownership                               |
| Runtime           | Browser-only or SSR, API origins, CORS constraints, supported browsers                     |
| Critical journeys | Sign-in/out, primary reads/mutations, billing/admin flows, failure UX                      |
| Existing evidence | Unit/integration/E2E coverage, monitoring, known complaints/workarounds                    |
| Migration risk    | Low/medium/high, data/security/revenue impact, blackout windows                            |
| Cohort            | Canary, standard, complex, deferred, retired                                               |

The inventory is complete only when every known site has an owner and an explicit disposition. Unknown local patches must be captured as requirements or deleted intentionally.

## Cohorts

### Cohort A — Framework canary

Choose one actively maintained, lower-risk site that exercises normal authenticated reads and mutations. Prefer good automated coverage and a team available for rapid feedback. The canary validates documentation, migration tooling, telemetry, and rollback—not just framework tests.

### Cohort B — Standard sites

Sites using unary JSON operations, standard auth, and no locally modified modules. Migrate after the canary observation window succeeds.

### Cohort C — Capability-heavy sites

Sites using uploads, downloads, streams, sockets, SSR, custom auth, or optimistic mutations. Schedule only after the matching phase checkpoint is complete.

### Cohort D — Heavily customized or deferred

Sites with forked modules, undocumented backend routes, insufficient tests, or business blackout constraints. Assign an owner and date; “deferred” is not an unowned permanent state.

## Per-site migration procedure

### 1. Freeze and reproduce

- record the exact dependency pin and lockfile;
- verify the current artifact can be restored from the registry/cache;
- run the current test/build/deploy path;
- capture known complaints and workarounds;
- tag or otherwise identify the last known-good deployment.

### 2. Add characterization evidence

- cover critical user journeys before changing framework calls;
- add tests for local workarounds and ambiguous legacy behavior;
- capture request/error/metadata behavior without recording secrets;
- identify behavior that should be preserved versus intentionally corrected.

Characterization tests are temporary only when explicitly marked with a removal issue; useful business behavior becomes permanent coverage.

### 3. Install the migration release

- update to an exact prerelease/migration version on a branch;
- install the generated application contract package and verify its graph hash;
- use `/hono-v4` for untouched Hono calls or `/legacy-rest` for characterized pre-Hono URL
  calls; do not route new operation calls through the root message-only client;
- do not relax TypeScript/lint rules to make the upgrade compile;
- keep mechanical dependency/generated changes separate from behavioral edits.

Run `ship-angular migrate-imports .` first and inspect the dry run. `--write` currently applies
only the deterministic Firebase adapter entrypoint move. The command deliberately leaves session
auth, URLs, operation IDs, and behavior for the capability migration steps below.

### 4. Migrate by capability

Recommended order:

1. provider and environment configuration;
2. unary read resources;
3. mutations and declared error handling;
4. authentication/session behavior;
5. uploads/downloads;
6. streams/sockets;
7. schema forms;
8. copied/custom modules.

Each converted call uses a stable operation ID and contract input. Do not wrap new clients in an application-local recreation of the old arbitrary thunk API.

### 5. Verify staging

- run site unit/integration/E2E tests and changed-file coverage;
- exercise sign-in, refresh, sign-out failure, authorization denial, validation, rate limit, offline/timeout, and cancellation;
- exercise every transport capability the site uses;
- compare request counts so retries do not duplicate mutations;
- inspect browser and SSR bundles for server-only dependencies;
- confirm request IDs and safe errors reach logs/diagnostics;
- run accessibility and performance smoke appropriate to the site.

### 6. Deploy with rollback ready

- name deployment and rollback owners;
- preserve the old lockfile/artifact/deployment;
- define the observation window and success/error thresholds;
- deploy during an owned window;
- watch client errors, auth failures, API request rate, mutation attempt count, stream/socket reconnects, and business-critical journeys;
- roll back rather than patching forward blindly when a stop condition is met.

### 7. Close the migration

- record deployed versions and graph hash;
- link CI, staging, production smoke, monitoring, and rollback evidence;
- remove compatibility usage in the site where feasible;
- record any framework issue discovered and its owning phase/PR;
- close only after the observation window succeeds.

## Rollback contract

Every site retains:

- its last known-good ShipAngular/ShipAPI pins and lockfile;
- access to the corresponding package artifacts;
- compatible deployment configuration and generated contract artifact;
- a documented deployment rollback command/process;
- an owner able to execute it during the observation window; and
- data compatibility confirmation when a frontend rollout accompanies backend changes.

Frontend version pins alone are insufficient if the backend stops honoring the old wire contract. ShipAPI must publish the compatibility/deployment window for each client artifact version.

## Stop conditions

Pause or roll back a site migration when any of these occurs:

- authentication/session state is ambiguous or credentials cross an origin/user boundary;
- a mutation can execute more than once unexpectedly;
- a declared error becomes a generic exception or loses request correlation;
- SSR data can cross requests;
- upload/download bytes or stream/socket messages are corrupted;
- bundle growth exceeds the approved site budget;
- critical journey error rate exceeds the agreed threshold; or
- the old deployment cannot be restored reliably.

## Compatibility-adapter removal gate

The adapter may be removed from the new framework line only when:

- the site inventory has no unknown owners/usages;
- every active site is upgraded or has an approved, dated exception on an old supported pin;
- no upgraded site imports either compatibility entrypoint;
- all observation windows have closed successfully;
- old artifacts and support expectations are documented;
- migration documentation/codemods have been validated on at least the canary and one capability-heavy site; and
- removal ships as an explicit breaking change with a Changeset.

Pinned old framework versions may retain their historical code. The new architecture does not need to carry compatibility forever merely because old artifacts remain installable.

## Migration record template

```text
Site:
Repository / deployment:
Business owner / engineering owner:
From ShipAngular / ShipAPI versions:
To ShipAngular / contract / ShipAPI versions:
Contract graph hash:
Cohort and risk:
Capabilities used:
Known legacy behavior/workarounds:
Characterization tests:
Automated migration output and manual edits:
CI and coverage:
Staging evidence:
Production deploy:
Observation window and metrics:
Rollback version/process/owner:
Outcome and follow-up issues:
```
