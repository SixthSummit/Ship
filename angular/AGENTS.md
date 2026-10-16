# AGENTS.md — ShipAngular framework

This file is the canonical reference for AI coding agents working on the Angular framework within the Ship monorepo. Tool-specific files (`CLAUDE.md`, `.cursor/rules/*.mdc`) defer to this document for shared content.

---

## What this repository is

**ShipAngular is a frontend-only framework.** This guide covers the Angular half of the Ship monorepo:

- **ShipAngular** — Angular 20 frontend (`packages/angular`).
- **ShipAPI** — Drizzle-based backend (sister framework in this workspace, independent release cadence).

Server functions, RPC, and database access live in **ShipAPI**, not here. Prospects evaluating ShipAngular against full-stack frames (Next.js, Redwood, T3) should evaluate the **ShipAngular + ShipAPI** pair, not ShipAngular alone. Treat the two-framework split as deliberate and load-bearing — do not propose collapsing them.

The current stable line is **4.x**. `dev` is the active trunk with alpha snapshots; `main` owns stable releases. The operation-client rebuild is integrated. Application migrations still require their own conformance and rollout gates. The 3.x line is not maintained.

---

## Where things live

```text
Ship/
├── packages/angular/                # @sixthsummit/ship-angular (published)
│   ├── src/                         # root public API and compatibility surfaces
│   ├── operations/, ship-api/        # structural operation client and API adapter
│   ├── auth/, firebase-auth/         # authentication entrypoints
│   ├── download/, upload/, stream/, socket/, realtime/
│   ├── forms/, query/, testing/      # typed forms, TanStack Query, conformance helpers
│   ├── hono-v4/, legacy-rest/        # migration-only compatibility
│   ├── cli/, schematics/, eslint/    # consumer tooling
│   ├── templates/default/           # generated application scaffold
│   └── package.json                 # published version source of truth
├── apps/angular-docs/               # Starlight site; content generated from angular/docs
├── angular/                        # private Angular tooling workspace
│   ├── conformance/                 # synthetic fixtures and packed consumer checks
│   ├── scripts/                     # version sync, docs, bundles, conformance
│   ├── docs/                        # canonical Angular documentation and ADRs
│   ├── .claude/, .cursor/           # Angular agent conventions
│   ├── AGENTS.md                    # this guide
│   └── package.json                 # Angular verification commands and tools
├── .changeset/                      # independent releases for both frameworks
├── .github/workflows/               # shared CI and manually enabled publishing
├── pnpm-workspace.yaml, pnpm-lock.yaml, turbo.json
└── package.json                     # shared workspace commands
```

---

## Locked conventions (4.0 line)

1. **Standalone components only.** No `NgModule`. Verified absent in current code.
2. **Signal-first public API.** `Signal<T>` and `WritableSignal<T>` are the canonical reactive primitives. Public exports MUST NOT return `Observable<T>` directly (enforced by the `ship-angular/no-rxjs-in-public-api` ESLint rule).
3. **`inject()` over constructor DI.** Every service and component uses `private foo = inject(Foo)`. Constructor parameters are forbidden for DI (enforced by `ship-angular/use-inject`).
4. **`ChangeDetectionStrategy.OnPush` on every component** (enforced by `ship-angular/onpush-required`).
5. **Functional guards and interceptors.** No class-based `@Injectable` guards. `CanActivateFn` only. HTTP auth uses a functional `authInterceptor` registered via `withInterceptors([...])`.
6. **New control flow only.** `@if`, `@for`, `@switch`, `@defer` — never `*ngIf`, `*ngFor`, `*ngSwitch`. Already fully migrated.
7. **Typed reactive forms.** `FormGroup<{ field: FormControl<string> }>` shape; no untyped forms.
8. **Functional file naming = selector.** `MyThing` lives in `my-thing.component.ts` with selector `app-my-thing`.
9. **One concept per file.** No co-located helpers; if a helper is reused, it gets its own file.
10. **`provideAppInitializer`** (function form) — never the deprecated `APP_INITIALIZER` token.
11. **Routes are guarded or public.** Every route must either declare a `canActivate` or appear in the public-routes allowlist (enforced by `ship-angular/route-guard-or-public`).
12. **Auth state lives in `AuthService.state: Signal<AuthState>`.** `user$` does not exist on the 4.0 line.
13. **Data fetching uses explicit resources.** New ShipAPI work uses `createOperationResource()` and stable operation IDs as defined by ADR 0002. Generic third-party REST remains separate. The existing overloaded `createResource()` and its Hono thunk are legacy compatibility surfaces during migration; do not expand their responsibilities.

These are not aspirations. They are the enforced shape of 4.0 code. ESLint custom rules in `../packages/angular/eslint/rules/` automate the checks.

---

## Build, test, lint, release

```bash
# install (the repository package manager is pinned)
pnpm install --frozen-lockfile

# type-check, lint, format-check, build, test
pnpm run ci

# isolated commands
pnpm type-check              # strict source and public type programs
pnpm lint                    # Angular ESLint semantics + Biome import ordering
pnpm format:check            # Biome code + Prettier docs/templates
pnpm test                    # Vitest through Turbo
pnpm test:coverage           # enforced >=80% in all metrics
pnpm build                   # ng-packagr secondary entrypoints + docs
pnpm test:packed-conformance # required offline tarball boundary
pnpm test:browser-conformance # required packed real-browser transport boundary

# bookkeeping
pnpm sync-version        # writes version.ts + syncs version mirrors
pnpm measure-bundle      # captures package output sizes
pnpm knip                # every maintained entrypoint/type fixture

# CLI smoke (no network)
node ../packages/angular/cli/ship-angular.js create test-project --skip-install
```

Releases use the root [Ship release guide](../RELEASE_GUIDE.md). Changesets live at the workspace root; publishing is prepared on branch pushes, requires release approval, and is gated by `SHIP_PUBLISH_ENABLED`. Run Angular commands from `angular/` or use `pnpm --filter ship-angular` from the root.

### Contribution and test standards

- Commits and PR/squash titles follow Conventional Commits. Use imperative subjects under 50 characters when practical; use `fix` only for user-facing defects. See `CONTRIBUTING.md` and `.gitmessage`.
- Consumer-visible package/template/module changes include a Changeset independently of the commit type.
- Vitest is the unit/integration framework. New or substantively rewritten tests use colocated `FileName.test.ts`; existing `.spec.ts` remains supported until an isolated migration.
- Coverage must be at least 80% for statements, branches, functions, and lines globally and for materially changed files.
- Required tests do not skip because a sibling checkout, live service, or local dependency is absent. Any non-required skip states its reason, owner, and removal condition.
- AI-generated tests are expected but must be reviewed for correct assertions, regression sensitivity, errors, and edge cases.
- Use the root `.github/PULL_REQUEST_TEMPLATE.md` and include commands/CI, coverage, skipped-test count, compatibility, risk, rollout, rollback, and Changeset evidence.

---

## ShipAngular ↔ ShipAPI contract

**Structural operation client primary (accepted 2026-09-03).** Read `docs/architecture/decisions/0002-operation-client-contract.md` before changing the integration seam. `docs/architecture/CONTRACT.md` preserves the superseded Hono v4 decision as compatibility history.

Implemented surface on `dev`:

- **`/query`:** optional TanStack Query integration for reads, mutations, cache scopes/keys, infinite reads, and SSR hydration; pending release. See `docs/guides/TANSTACK_QUERY.md`.

- **`/operations`:** `OperationClient<TContract>.call(operationId, input, options)`, lossless results/errors/metadata, request policy, typed DI, SSR context, `createOperationResource()`, and `createOperationMutation()`.
- **`/ship-api`:** import-free adaptation of ShipAPI's current `ClientContract` manifest and structural HTTP client into the normalized operation executor.
- **`/auth`:** operation-backed honest session state and shared cookie/CSRF credential capabilities.
- **`/firebase-auth`:** optional Firebase provider integration, isolated from the root and operation bundles.
- **`/realtime`:** declared realtime publication typed from the manifest's `channels`, with presence, reconnect/resubscribe, and an SSR no-op. Socket.IO is an optional peer of this entry only. See ADR 0005 and `docs/guides/REALTIME_SUBSCRIPTIONS.md`.
- **`/download`, `/upload`, `/stream`, `/socket`:** explicit non-JSON capability contracts with cancellation and protocol state. `/stream`'s `createStream()` implements the canonical SSE wire contract for operations declared `response.mode: "stream"` (ADR 0004).
- **`/push`:** optional Angular service worker subscriptions and signals, with explicit app-owned persistence and an SSR no-op. See ADR 0006 and `docs/guides/WEB_PUSH.md`.
- **`/forms`:** generated client-safe form bindings; no Drizzle or server-schema import.
- **`/testing`:** reusable auth and operation-client conformance helpers.
- **Compatibility:** `createResource()` keeps its current URL/factory and Hono thunk shapes during migration. New behavior belongs in explicit operation APIs.
- **Compatibility:** `/hono-v4`, `provideShipApiClient`, `SessionAuthAdapter`, legacy transports, and fetch wrappers are migration-only surfaces.
- **Compatibility:** `/legacy-rest` maps pre-Hono URL clients one operation at a time without weakening the target client or preserving lossy `Promise<T>` errors.
- **Compatibility:** current interceptors and `withX(fetch)` wrappers remain until callers move to the operation-aware policy pipeline; do not add another duplicated concern.
- **Boundary proof:** `pnpm test:packed-conformance` and `pnpm test:browser-conformance` cannot use a sibling checkout or skip; `pnpm test:joint-conformance` requires ShipAPI's real manifest.

**OpenAPI codegen for `ApiClient`** is for **third-party REST APIs only** — not the ShipAngular ↔ ShipAPI integration path.

Schematics run through `pnpm exec ng generate @sixthsummit/ship-angular:<name>`. The API schematic generates the structural provider boundary, never `hc()`. The `operation-resource`, `operation-mutation`, `operation-auth`, `download`, `socket`, `upload`, `signed-upload`, `stream`, and `operation-form` schematics generate binding-driven app wrappers without inventing URLs, identity casts, codecs, origin allowlists, or error policy. Run `ship-angular audit-migration` before changing a pinned client; use `migrate-imports` only for its dry-run-first deterministic entrypoint moves.

---

## Before you change X, read Y

| Touching                                                 | Read first                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `../packages/angular/src/auth/services/AuthService.ts`   | the AuthAdapter conformance suite at `../packages/angular/src/auth/adapters/conformance.spec.ts`                                              |
| `../packages/angular/src/auth/adapters/AuthAdapter.ts`   | `docs/architecture/AUTHENTICATION.md` and the conformance suite — interface changes affect every adapter                                      |
| `../packages/angular/stream/src/create-stream.ts`        | `docs/architecture/decisions/0004-streaming-response-mode.md` — the SSE wire contract is shared with ShipAPI; changing it is a joint decision |
| `../packages/angular/src/api/resource/createResource.ts` | ADR 0002 and `docs/architecture/phases/PHASE_03_RESOURCES_AND_COMPATIBILITY.md` — this is a compatibility surface, not the new kernel         |
| `../packages/angular/*/src/public-api.ts`                | each is a published secondary entrypoint and an independent bundle contract                                                                   |
| `../packages/angular/src/version.ts`                     | auto-generated; edit `../packages/angular/package.json` instead and run `pnpm sync-version`                                                   |
| app-owned features                                       | generate under `src/app/modules/<name>`; there is no framework source-copy catalog                                                            |
| `../packages/angular/templates/default/`                 | this is shipped to every new project; assume third-party app developers read it                                                               |
| `tsconfig.json`, `eslint.config.js`                      | conventions are enforced here; coordinate with `../packages/angular/eslint/rules/`                                                            |
| Release-related files                                    | the root `RELEASE_GUIDE.md`, `.changeset/config.json`, and `.github/workflows/release.yml`                                                    |

---

## Things to avoid

- **Don't add full-stack features.** Server actions, database adapters, SSR-only data loaders, server-side auth — all belong in ShipAPI. ShipAngular is frontend-only by design.
- **Don't reintroduce `Observable<T>` in public APIs.** The conversion has been done. RxJS is allowed internally where it's the right tool, but public surfaces are signals.
- **Don't add `NgModule`.** Standalone components only.
- **Don't bypass `inject()`.** Constructor DI is forbidden in 4.0 code; the ESLint rule will error.
- **Don't edit `../packages/angular/src/version.ts` directly.** It's auto-generated.
- **Don't edit `../apps/angular-docs/src/content/docs/*.md` directly.** The Starlight docs site is a generated mirror of `/docs/*.md`. `scripts/copy-docs.mjs` runs on `predev` / `prebuild` (and a CI drift-guard fails the build if the mirror is out of sync). Edit the canonical SHOUT_CASE files under `/docs/`; the kebab-case mirror is regenerated automatically.
- **Don't propose collapsing `ShipAngular + ShipAPI` into a single framework.** The split is deliberate.
- **Don't pull `@defer` into library components.** Defer triggers belong to the consuming app, not the library.
- **Don't import a composed Hono app or server package for types.** Consume only packed browser-safe contract/client artifacts.
- **Don't extend legacy wrappers/interceptors for ShipAPI behavior.** Add the capability to the operation policy or explicit transport entrypoint.

---

## Where to look for more

- `CLAUDE.md` — Claude-Code-specific surface (slash commands, skills, hooks, MCP).
- `.cursor/rules/*.mdc` — Cursor MDC rules mirroring this document.
- `../packages/angular/CLAUDE.md` — library-specific guidance (ng-packagr constraints, public-api boundary).
- `docs/architecture/decisions/0002-operation-client-contract.md` — current ShipAPI integration decision.
- `docs/architecture/decisions/0005-declared-realtime-publication.md` — declared realtime channels and the transport boundary.
- `docs/architecture/decisions/0004-streaming-response-mode.md` — the SSE wire contract shared with ShipAPI; `docs/guides/STREAMING_OPERATIONS.md` is the consumer guide.
- `docs/architecture/CONTRACT.md` — superseded Hono v4 decision retained for compatibility history.
- `docs/INTERIM_BACKEND.md` — using ShipAngular without ShipAPI.
- `docs/ROADMAP.md` — deferred work + explicit non-items.
- `SECURITY.md` — AuthAdapter trust boundary.
- `docs/architecture/REARCHITECTURE_PROGRAM.md` — phased implementation and checkpoints.
