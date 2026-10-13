# ShipAPI v4 — Alpha 2 Hardening Plan (path to GA)

> **Status**: working document — iterate against it. Not a tracker of record yet; reconcile with [`V4_STATUS.md`](V4_STATUS.md) (the master execution tracker) as items land.
> **Companions**: [`DELIVERY_METRICS.md`](DELIVERY_METRICS.md) (how we'll measure the rollout), [`V4_STATUS.md`](V4_STATUS.md) (milestones + B/G/P/V gates).
> **Created**: 2026-05-30.
> **Legend**: ☐ todo · ◐ in progress · ☑ done · sizes S/M/L (rough dev effort).

## The arc

Alpha 2 is the **contract-lock milestone**. The one thing the alpha window buys us is *cheap irreversibility* — we can still break anything before apps pin to v4; once they migrate, every change is a portfolio-wide cost. So the spine of this plan is:

1. **Lock what becomes permanent** (Phase 1) — the contracts that get written into every app's code and database.
2. **De-risk the two big bets while the evidence is still capturable** (Phase 2) — modernization parity and agent-tool parity.
3. **Build the durable surfaces that compound** (Phase 3) — sustainability norms, telemetry, decoupling.
4. **Refine the AI library** from clever-and-fragile toward boring-and-durable (Part II).
5. **Polish last** (Phase 4) — none of it locks in.

Everything is ranked by **cost-of-delay**, not by how interesting it is. When Phase 1 + the AI thinning (AI-R1/R2) land and the Phase-3 norms are written, we can cut Alpha 2; everything after that is additive toward GA.

## What we are explicitly NOT doing (locked — don't reopen)

- **OpenAPI compatibility layer** — deferred to v4.x (`V4_STATUS` V1); trigger is a real external-consumer requirement.
- **The `hc()` typed-client contract** — locked; it's the cross-framework seam.
- **Hono / Drizzle substrate picks** — settled. Drizzle is a *watch-item* (A2-7), not a reopen.
- **External-sale productization** — not the driver; this is internal-delivery infra.

## Current status — resume point (2026-05-31)

**Branch** `feat/alpha2-hardening` — 29 commits over `origin/dev` (incl. this status bump); `dev` clean; **not pushed / not PR'd** (A2-1a is now complete — the relocation is whole, so the PR is no longer held for it). `README.md` has an unrelated pre-existing edit — leave it.

**Done & verified** (build · type-check [core + module source] · unit 1697 · lint · integration-suite resolution; integration *execution* is CI/Docker only):
- **A2-1a.0** ☑ — module + library tests gate via root vitest; chunking/email unbroke.
- **A2-1a c1** ☑ `a984965` — root `vitest.integration.config.ts` + `test:integration`; CI repointed.
- **A2-1a c2** ☑ `4c598d9` — accounts/roles/permissions/rolePermissions → `modules/accounts/schema.ts` (+ `accountsSchema` fragment); accounts/oauth integration suites moved into their modules; testcontainer harness re-exported as `@sixthsummit/ship-api/testing`; `me-reference` uses a local fixture; refresh_tokens FK temporarily dropped.
- **A2-1a c3** ☑ `d31c52b` — refresh_tokens → `modules/accounts/schema.ts`, FK restored; JWT-auth machinery stays in core as DI primitives; **core ships zero concrete tables**; `defaultSchema` now empty.
- **A2-1a c4** ☑ `1348ad5` — `defaultSchema`/`DefaultSchema` + the `app/schema/` dir **deleted** (the `@sixthsummit/ship-api/app/schema` subpath is retired; also pruned the stale `lib/app/schema/*` orphans `tsc` never cleans, so the published artifact ships none); last `...defaultSchema` spreaders dropped (outbox integration test, template `db/schema.ts`); template composition finalized on **`src/modules/`** — `g *` scaffolders (+ tests) + template docs repointed there so `add` and `g` agree; coherence sweep (comments, `g` "Next steps", `oauth`/`outbox` module.json → `...accountsSchema`).
- **A2-1** ☑ `c54f7d1` — tenancy opt-in primitive: `tenantScoped(tenants)` factory mixin + `TenantScoped` (core, barrel); `resolveTenant()` middleware; **`requireAuth` now publishes `RequestContext.userId`** (un-breaks the always-null `createdBy`/`updatedBy` audit-stamping); accounts opt-in `tenants` table + `tenantsSchema` (separate from `accountsSchema`) + commented `accounts.tenantId`; `outbox.tenant_id` text→uuid; `getRequestContext` barrel-exported; `docs/v4/concepts/tenancy.md`. Adversarial-reviewed (6 findings fixed / 7 refuted). Enforcement (RLS/auto-scoping) stays V8.
- **A2-2 + A2-3** ☑ `65c2dc4` — contract freeze: `docs/PUBLIC_API_SURFACE.md` (export-path tiers · barrel · column primitives + accounts table shapes · error envelope + code/status map · module.json + scaffold · permission-slug convention · hc() seam); A2-3 query-DSL `QueryFilter`→`DslQueryFilter` rename (hook `QueryFilter` keeps the name); middleware `Options` types + `PermissionDefinition` barrel-exported; g-module `module.json` template `defaultSchema`→`accountsSchema`. Barrel was already minimal — no trims.
- **A2-6** ◐ `fe2dd84` — parity harness *started*: `runParityFixture`/`parseParityFixtures` + JSONL fixture format via `@sixthsummit/ship-api/testing`; `test:parity` gate; 11 `v4-conformance` checks lock the error envelope + auth-401. Real `v3-capture` from a live v3 app is the maintainer's step (wasting-asset oracle).
- **A2-4 + A2-5** ☑ `f6e2992` — release/versioning plumbing + contract: `packages/core` reconciled `alpha.1`→`alpha.2` (tag-scheme collision documented w/ next-release caveat); `docs/RELEASING.md` (Changesets pre-alpha release loop · tag convention · pre-publish checklist with the codemod gate scoped post-GA) + `docs/VERSIONING.md` (SemVer measured against the locked surface · deterministic deprecation window · codemod-per-break · pinned cross-app upgrade model · alpha window). Shared Contract/Reach-through tier vocab with the surface doc; VERSIONING + the (missing) A2-6 parity-harness.md now projected to the site. Adversarial-reviewed (1 blocker + 11 findings fixed).
- **A2-7** ☑ `f5b0828` — Drizzle hedge lint guard: `@typescript-eslint/no-restricted-imports` on `drizzle-orm` (+ the `sql*`/`**/expressions` subpaths, so `import {eq} from "drizzle-orm/sql"` can't dodge it; `allowTypeImports`; pg-core columns free) in BOTH the repo config and the consumer template — services express queries via QueryOptions, raw Drizzle stays in the data-access layer (app/db / src/db / schema). `modules/**` un-ignored so the guard bites in-repo (outbox/oauth services carry justified disables; trivial module-test lint debt fixed). Adversarial-reviewed (2 blockers fixed: subpath bypass + modules-ignored).
- **A2-8** ☑ `3df355c` — agent output-parity instrumentation: `g module/resource` now stamp `scaffold.tool` (env-detected: Claude Code via `CLAUDECODE` / Cursor via the `SHIP_API_SCAFFOLD_TOOL` override / `cli`) so time-to-module splits by tool; `docs/AGENT_PARITY_RUBRIC.md` (the G4 manual eval → a fixed module task scored 0/1/2 per tool) + new `DELIVERY_METRICS` M6 + retro tool-dimension; V4_STATUS G4 → the rubric. The cross-tool baseline RUN is the maintainer's. Adversarial-reviewed (tightened CLAUDECODE detection, rubric lint-vs-review split, env-branch tests).
- **A2-9** ◐ `d5ea237` — G2 external-review **brief** shipped (`docs/SECURITY_REVIEW_BRIEF.md`): packages the internal audit for a third-party firm (pre-migration timing gate, threat model, start-here off the 28 closed findings, in-scope surfaces w/ pointers, logistics); reconciled the audit's R1 with the A2-1 tenancy model. Commissioning + clearing the review is the maintainer's step.
- **Part II (AI lib) — AI-R1 ☑ `7f66aca`, AI-R2+R3 ☑ `611886a`, AI-A3 ☑ `a8f9d08`** — `libraries/ai` thinned per "altitude ∝ 1/volatility": R1 made the `LLMProvider` seam genuinely pass-through (`raw`/`providerExtras` populated outbound; `reasoningTokens`; fixed the `providerOptions` drop in agentLoop/RAG); R2 moved `agentLoop` to `/experimental` (breaking — no stability promise); R3 deprecated the heuristic tokenizer (truth = response `usage`) + added thin estimators; A3 versions the lib independently (`library.json` 0.1.0→0.2.0 + `.ship-lib.json` stamp on `add -l` + CHANGELOG). 102 ai/stamp tests; each understand-workflow-grounded, R1 adversarially reviewed.

**Decided in c4 — canonical consumer-app module location is `src/modules/`** (was split: `ship-api add` → `src/modules/`, `g *` → root `modules/`). Resolved toward `src/modules/`: the `g module|resource|service|schema|job` scaffolders, the template (`index.ts`/`db/schema.ts`/`config/modules.ts`/`drizzle.config.ts`/`AGENTS.md`/`README.md`/`tsconfig`), and `add` now agree. The monorepo root keeps its own `modules/` (its workspace layout — unchanged).

**▶ Phase 1 ✓, Phase 2 ✓ (framework-side), Part II ✓ — every Alpha-2 cut criterion below is met; the irreversible/breaking set is locked, so Alpha 2 is ready to cut.** What remains is **maintainer-owned + non-blocking**: the three ◐ external steps (A2-6 v3-fixture capture · A2-8 Claude-vs-Cursor baseline run · A2-9 commission the security review) and the Alpha-2→GA additive work. **Next:** cut Alpha 2 (`changeset version` → publish → tag, per `RELEASING.md`), or pick up an additive AI item (AI-E1 RAG golden path · AI-A1 usage tracker · AI-A2 eval harness · AI-A4 Gemini adapter).

**Follow-ups from c4 — resolved** (A2-1a follow-up commit):
- ☑ **`ship-api add` honest cleanup**: removed the dead `updateModulesConfig` (rewrote an `export default [...]` nothing consumed); `add` now relies on each module's `module.json` `postInstall` for explicit next-steps. `config/modules.ts` → documented placeholder pointing at the type-safe `src/index.ts` seam. The real **module auto-wiring** ask (v3 parity) is promoted to **A2-1b** below — a type-clean `wireModules` stub isn't possible without it.
- ☑ **Plugin hooks**: corrected — the PostToolUse/Stop matchers use *substring* matching (`*modules/*`), so they already fire for `src/modules/`; only one guidance-text line (`block-migration-edit.sh`) hardcoded the old path and is now location-neutral. (Earlier "won't fire" note overstated it.)
- ☑ **`defaultSchema`/`app/schema` doc+skill refs**: swept — 3 `.cursor/rules` (+ `sync:skills` re-pin), 2 SKILL.md, 2 plugin agents, root `AGENTS.md`, 6 `docs/` (+ `apps/docs` regenerated via `copy-docs`). Only intentional mentions remain (the "removed" breadcrumbs, the changeset, this plan's history, and accurate historical comments in `modules/accounts/schema.ts`).

**Docs module-path pass — resolved** (`b555e90`):
- ☑ **Converged consumer module paths to `src/modules/`** across the v4 docs + migration guide. Fresh-app docs (`generators.md`/`cli.md`/`jobs.md` `g`/`add` output locations + code-comment paths) → `src/modules/`. `MIGRATION_V3_TO_V4.md` converged on the decision that **migrated apps also land modules at `src/modules/<name>/`** (uniform with fresh apps + `g`/`add`; avoids split-brain); the v3-"before"/`migrate-orm`-input snapshots, the monorepo "mirror `modules/accounts/`" pointers, and GitHub links stay root `modules/` (correct — the before/after contrast shows the relocation).
- ☑ **Removed the last dead `@sixthsummit/ship-api/modules/*` package-subpath refs** (folded in): `jobs.md` outbox imports → `./modules/outbox`; template `src/index.ts` "Wire your modules" comment → `./modules/accounts/index.js` (a **c4 miss** — reported fixed in c4 but the edit hadn't landed). Residual mentions are only this plan's task-description text.

**Execution facts c4 / A2-1 need**: module delivery = reference-source/copied-in; identity (accounts/roles/permissions/refresh_tokens) + the `accountsSchema` fragment live in `modules/accounts/schema.ts`; `oauth` FKs accounts via `../accounts/schema.js`; module unit + integration tests run via the root vitest configs.

---

# Part I — Framework hardening

## Phase 0 — Scope (do first; gates everything else)

**A2-0 — Pull audit** · S · ☑ — **COMPLETE 2026-05-30**
- *What*: For every non-core adapter / module / library, name the current consumer; no consumer → defer.
- *Result*:
  - **KEEP**: `accounts` (relocate, A2-1a), JWT-auth + `refreshTokens` (→ auth module, A2-1a), `firebase` adapter, `ai` (refactor, Part II), `weaviate`, `chunking`, `RedisCache`/`InMemoryCache`, `oauth` module (+ its provider adapters + `MockOAuthAdapter`), `outbox` module, `email` library, storage **GCS** + **Disk**, LLM **Anthropic** + **OpenAI**.
  - **DEFER** (no current consumer; both already built, so "defer" = demote from the first-class/maintained+CI surface — code stays, cheap to revive): storage **S3** adapter, **`bullBoard`** jobs UI. *(Override S3 if you expect S3-based clients soon.)*
  - **ADD** (pulled but missing): **Gemini LLM adapter** — apps use Gemini; no adapter exists today. → new item **AI-A4**.
- *Consequence*: LLM is genuinely **multi-provider** (Anthropic + OpenAI + Gemini), which **re-scopes AI-R1** — the cross-provider seam is justified (keep it); the discipline is "pass native features through, don't LCD-flatten," not "thin because you're single-provider."

## Phase 1 — Lock the contracts (Alpha 2 gating; highest cost-of-delay)

**A2-1a.0 — Make the module system first-class** · M · ☑ — **DELIVERED 2026-05-30** (model: reference-source, copied-in). Prerequisite to A2-1a.

*Why now*: A2-1a moves load-bearing identity into `modules/`, but modules are currently second-class — not workspaces (they resolve `@sixthsummit/ship-api` from built `lib/` via a `node_modules` symlink), their unit tests aren't run by `npm test`/`ci` (core-workspace-only), and module *integration* tests have no runner at all (root vitest excludes `*.integration`; core's integration config is `packages/core/src`-scoped). Moving auth/accounts in without fixing this silently drops their tests from CI.

*Decision*:
- **Module delivery = reference source, copied into the consumer's app via `ship-api add`** — the consumer owns and tailors it (multi-tenant or not). Modules are **not** published package subpaths; remove the dead `@sixthsummit/ship-api/modules/*` references (e.g., the template comment).
- **Wire module tests into the flow**: `npm test` / `ci` run the root `vitest.config.ts` (already globs `modules/**` + `libraries/**` unit tests — just not invoked today); add a root integration runner so `modules/**/*.integration.test.ts` execute. Resolution stays via built `lib/` (per the AGENTS.md class-identity convention), so module tests run post-build.

*Done when*: `npm test`/`ci` exercise module + library unit tests; module integration tests have a runner; dead `modules/*` subpath references removed; all currently-unrun module/lib tests green under the new wiring.
*Discovered (2026-05-30, root-vitest dry-run)*: turning the wiring on surfaces **5 broken files** — `libraries/chunking` ×4 and `libraries/email` ×1; 1585 other tests pass. Root cause for chunking: it imports `tiktoken`, which **is** declared in `chunking/library.json` `npmDependencies` (so consumers get it via `ship-api add -l chunking`, which runs `npm install`) but is **not installed in the framework repo** — the repo never installs its libraries' manifest deps for their own tests, so these have been silently untested here. So A2-1a.0's fix is not "add an undeclared dep" but "**install library/module-declared manifest deps repo-side for testing**", ideally derived from `library.json`/`module.json` so root and manifest don't drift. Diagnose `libraries/email` ×1 separately. (`tiktoken` is OpenAI's BPE — fine to unbreak now; whether it's right for a Claude-forward RAG stack is a Part II / AI-R3 question.)
*Delivered (commits 1–2)*: ☑ unbroke the 5 hidden-failing files (installed `tiktoken`/`resend` repo-side; decoupled `EmailService` from the host `environment` import → config via constructor); ☑ `npm test`/`ci` now run the root vitest config so **module + library unit tests gate** — 110 files / 1686 tests green.
*Reassigned (to stay verifiable)*: the **module integration-test runner** → folded into **A2-1a** (build + verify in CI with Docker when accounts/oauth integration tests actually move there); **manifest-dep derivation** → **A2-1a.1** (hand-mirrored `tiktoken`/`resend` devDeps work today); the **template dead-`@sixthsummit/ship-api/modules/*`-ref + copied-in composition** → **A2-1a** (entangled with finalizing the copied-in model; the template is internally inconsistent on module location — `modules/` vs `src/modules/` — best fixed holistically there).
*Maps to*: prerequisite to A2-1a; resolves the module-delivery ambiguity from A2-0/A2-2.

**A2-1a — Relocate identity/RBAC out of core into modules** · M–L · ☑ — **DONE** (commits 1–4 `a984965`/`4c598d9`/`d31c52b`/`1348ad5`): integration runner · identity → modules · refresh_tokens → accounts + FK restored · `defaultSchema`/`app/schema` retired + template finalized on `src/modules/` — see *Current status* above. Unblocks A2-1; depended on A2-1a.0.

*Also owns (reassigned from A2-1a.0)*: build the **module integration-test runner** (root `*.integration.test.ts` config + wire CI) when the accounts/oauth integration tests move out of `packages/core/src/test/integration/`, so they're verified in CI as they land; fix the template's dead `@sixthsummit/ship-api/modules/*` reference + finalize the copied-in composition (resolve the `modules/` vs `src/modules/` inconsistency).

**A2-1b — Module auto-wiring (reconcile v3 ergonomics with the `hc()` contract)** · M · ☐ — surfaced resolving the c4 `add`-wiring follow-up.

*Why a feature, not a cleanup*: v3 auto-wired modules from a `modules.ts` list via a runtime loop. v4 can still auto-wire the **runtime** surfaces (permission-definition seeding, jobs, cron) from a manifest cheaply — but **route types** can't be: `hc<ShipApiClient>()` reads `typeof app` (the statically-chained Hono app; no codegen), and TS can't thread per-module route types through a runtime loop. The schema type (`createApp<TSchema>` → `db.query`) has the same constraint. Plus DI — modules like `oauth` need app-specific deps (adapters / credentials / state secret) with no v4 DI container.

*Approach (to design)*: build-time **composition codegen** — a `ship-api` step that reads installed modules and generates the explicit, type-preserving chained wiring (analogous to the drizzle-kit migration codegen v4 already uses), plus a per-module deps-resolution convention; `config/modules.ts` is the natural target. Optional hybrid: auto-register the type-free runtime surfaces now, codegen routes/schema later. **Not Alpha-2-gating** (additive DX; the `hc()` contract holds either way). Pairs with A2-2 (`module.json` `scaffold` block) + A2-1a.

**A2-1a.1 — Derive repo test deps from manifests** · S · ☐
- *What*: Replace the hand-mirrored root devDeps (`tiktoken`, `resend`) with a sync derived from `library.json`/`module.json` `npmDependencies` + a drift guard — mirror the existing `sync:skills`/`check:skills` pattern.
- *Why*: on install, the root mirror already drifted (`resend ^6.12.4` vs manifest `^6.7.0`); manifests should stay the single source of truth for a library's deps.
- *Maps to*: follow-up from A2-1a.0 / A2-0.

*Why now*: zero core-runtime coupling makes the move clean today — HTTP/auth/middleware/services import none of these tables, only the generic `AuthProvider<TAccount>` type and the bare `createdBy`/`updatedBy` uuid convention. After apps adopt and pin, relocating tables across package boundaries is brutal. Restores incremental adoptability and the pluggable-auth claim core currently contradicts.

*Decision* — **core = interfaces + conventions + primitives; modules = concrete identity tables + behavior**:
- Move `accounts` / `roles` / `permissions` / `rolePermissions` tables from `packages/core/src/app/schema/` into `modules/accounts/schema.ts` — the module becomes self-contained (schema + service + routes + permissions + validation).
- **JWT-cookie auth** — *executed more narrowly than first sketched* (c3): only the concrete `refreshTokens` **table** moved (into `modules/accounts`, since it FKs accounts). The whole machinery stays in core as DI primitives — `JwtSigner`, the `RefreshTokenStore` interface, the **generic** `DrizzleRefreshTokenStore` (takes the table via its constructor), and `AuthFlow` (pure DI). No separate auth module was needed.
- **Retire the core `defaultSchema`.** Each module exports its own schema fragment; consumers compose `createApp({ schema: { ...accounts.schema, ...billing.schema } })`. The `create` template composes the accounts module explicitly — a few more lines, the correct tradeoff for incremental adoption.

*Done when*: identity tables live in their modules; core `app/schema/` no longer ships them; `defaultSchema` removed; auth module owns `refreshTokens` + the Drizzle store (interface stays core); template composes modules explicitly; the type chain (`createApp<TSchema>` → `hc<ShipApiClient>`) still flows end-to-end; tests + build green.
*Maps to*: feeds A2-0 (pull audit) and A2-2 (contract freeze — core's public surface shrinks); prerequisite to A2-1.

**A2-1 — Tenancy as an opt-in primitive** · M · ☑ — **DONE** (`c54f7d1`): `tenantScoped(tenants)` factory mixin + `resolveTenant()` + the `requireAuth` userId-stamping fix + accounts opt-in `tenants`/`tenantsSchema` + `outbox.tenant_id` text→uuid + `getRequestContext` barrel export + `docs/v4/concepts/tenancy.md`; adversarial-reviewed. Enforcement (RLS, `withTenant`/ALS auto-scoping) stays deferred to `V4_STATUS` V8 — A2-1 shipped only the column shape + resolution convention.

*Decision* — tenancy is a **per-product / per-module choice**, never a core default:
- Core ships **`tenantScoped`** as an **opt-in mixin** (a primitive alongside `baseFields` / `baseFieldsTimestampsOnly`): `tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" })`. Core forces nothing.
- A **multi-tenant** product applies the mixin to its domain tables (index `tenant_id`, leading, usually `(tenant_id, <natural key>)`) and its accounts module adds a `tenants` root table + `accounts.tenantId` non-null FK. A **single-tenant** product simply doesn't use it.
- **Default shape when opted in**: one tenant per user (`accounts.tenantId` → `tenants.id`). Domain tables FK to `tenants`, not `accounts`, so a future move to membership (Model B) is an identity-tables-only migration.
- **Resolution convention**: read the active tenant from `RequestContext.tenantId`, **never** `account.tenantId` directly — keeps the A→B path a one-middleware change.
- **Name/type**: `tenantId` / `tenant_id`, `uuid` (matches `RequestContext.tenantId` + every other id).
- **RBAC**: permission definitions + roles stay global; per-tenant roles = a cheap nullable `roles.tenantId` add later, not irreversible → deferred.
- **Reconcile**: `outbox.tenant_id` `text` → `uuid` (keep nullable; outbox carries system/global events).

*Done when*: `tenantScoped` mixin shipped in core; the accounts module (when opted in) demonstrates `tenants` + `accounts.tenantId` + the resolution middleware; `outbox.tenant_id` reconciled; convention documented.
*Maps to*: splits the column-shape half out of V8; depends on A2-1a.

**A2-2 — Contract freeze pass** · M · ☑ — **DONE** (`65c2dc4`): locked surface in `docs/PUBLIC_API_SURFACE.md` (3 export-path stability tiers · barrel · column primitives + accounts table shapes · error envelope + code/status map · module.json + scaffold · permission-slug convention + `PermissionDefinition` · hc() seam). Barrel audited — already minimal, no incidental exports to trim; added the missing middleware `Options` barrel exports + fixed the `defaultSchema` g-module template ref.
- *What*: Audit and deliberately lock the surfaces apps code/migrate against: `baseFields`, default tables (accounts/roles/permissions/refresh_tokens), `module.json` shape (incl. the new `scaffold` block), error-response JSON shape, permission-slug convention, and the public export barrel.
- *Why now*: These are forward-compat commitments the moment an app depends on them. Minimize the barrel — every incidental export is a promise.
- *Done when*: a written "public API surface" doc; barrel trimmed; incidental exports marked internal.

**A2-3 — Fix the `QueryFilter` naming collision** · S · ☑ — **DONE** (under A2-2, `65c2dc4`): the query-DSL `QueryFilter` (`app/db/QueryOptions`) is renamed `DslQueryFilter`; the lifecycle-hook `QueryFilter` keeps the name and stays the barrel export.
- *What*: Rename one of the two public `QueryFilter` types (DSL-level vs lifecycle-hook) so the public import is unambiguous. Do under A2-2.
- *Why now*: free to rename today, annoying-but-locked once apps import it.

**A2-4 — Reconcile version / release plumbing** · S · ☑ — **DONE** (`f6e2992`): `packages/core` reconciled `4.0.0-alpha.1`→`alpha.2` (the drift was a tag-scheme collision — out-of-band bare `4.0.0-alpha.2` @ 2026-05-09 vs Changesets per-package `@sixthsummit/ship-api@4.0.0-alpha.1` @ 2026-05-29 — documented with the next-release caveat). `docs/RELEASING.md` is the maintainer release flow: Changesets pre-alpha loop, version/publish/tag, leaving pre-release, pre-publish checklist (codemod gate scoped post-GA).
- *What*: Resolve the drift — `packages/core/package.json` says `4.0.0-alpha.1`, docs say `alpha.2`, and there's no `v4.*` git tag. Restore tagging; document the release flow (changesets are in pre-release mode).
- *Why now*: versioning must be trustworthy before any app pins.

**A2-5 — SemVer + deprecation contract** · S · ☑ — **DONE** (`f6e2992`): `docs/VERSIONING.md` — the compatibility promise measured against the locked surface (MAJOR/MINOR/PATCH keyed to the export tiers; deterministic deprecation window; codemod-per-breaking-change; pinned cross-app upgrade model owned by the framework team; alpha window binding from the first stable 4.0.0). Shares Contract/Reach-through tier vocab with `PUBLIC_API_SURFACE.md`. Adversarial-reviewed with A2-4 (1 blocker + 11 findings fixed).
- *What*: Write the policy: what counts as breaking, deprecation window, and the cross-app upgrade model (pinned vs floating, cadence, who owns bumps).
- *Why now*: this is the social contract that keeps a shared-stack portfolio upgradeable — free to write today, impossible to retrofit trust into later. Must exist before the first pin.

## Phase 2 — De-risk the two bets (start now; the first item is time-sensitive)

**A2-6 — v3↔v4 behavioral-parity fixtures** · L · ◐ — **STARTED** (`fe2dd84`): differential harness shipped (`runParityFixture`/`parseParityFixtures` + JSONL format via `@sixthsummit/ship-api/testing`; `test:parity` gate; 11 `v4-conformance` checks locking the error envelope + auth-401; capture procedure in `docs/v4/tooling/parity-harness.md`). REMAINING: capture real `v3-capture` fixtures from a live v3 app (the wasting-asset oracle) — maintainer's step, no v3 app in this repo.
- *What*: A differential harness that captures v3 behavior on the surfaces that carry undocumented robustness (error shapes, auth edge cases, pagination bounds, query semantics) and asserts v4 matches.
- *Why now*: your running v3 apps are a parity oracle — and it's a *wasting asset* that disappears as apps migrate and v3 is decommissioned. The codemod proved structural migration; this proves behavioral parity. Capturable only while both stacks exist.
- *Done when*: fixtures captured from real v3 behavior; v4 asserted against them in CI.

**A2-7 — Drizzle hedge lint guard** · S–M · ☑ — **DONE** (`f5b0828`): `@typescript-eslint/no-restricted-imports` on `drizzle-orm` + the operator subpaths (`drizzle-orm/sql`, `**/expressions`) with `allowTypeImports`, in the repo config AND the consumer template — services route through QueryOptions; raw Drizzle stays in the data-access layer (app/db / src/db / schema), pg-core columns free. `modules/**` un-ignored so the guard bites on the reference modules (outbox/oauth services carry justified disables; trivial module-test lint debt fixed). Adversarial-reviewed (2 blockers fixed: the `drizzle-orm/sql` subpath bypass + the modules-ignored inert-guard gap). Ceiling (import-free `db.query`/`db.select`) documented as review-enforced.
- *What*: ESLint rule flagging raw Drizzle query-builder use outside the sanctioned data-access layer. Model on the existing `no-restricted-syntax` rule for raw `c.req.json`.
- *Why now*: `QueryOptions` is the ORM-swap insurance only if services route through it; every bypass erodes it. Cheap to enforce now.
- *Maps to*: pattern from alpha-3 ESLint work.

**A2-8 — Agent output-parity instrumentation** · S–M · ☑ — **DONE** (`3df355c`): `g module/resource` stamp `scaffold.tool` (Claude Code auto-detected via `CLAUDECODE`; Cursor via the `SHIP_API_SCAFFOLD_TOOL=cursor` override; else `cli`) → time-to-module splits by tool (M3/M6). `docs/AGENT_PARITY_RUBRIC.md` formalizes the manual G4 eval (fixed module task scored 0/1/2 across compile/tests/conventions/shape/end-to-end/autonomy, per tool); new `DELIVERY_METRICS` **M6** + retro tool-dimension; V4_STATUS G4 → the rubric. The cross-tool baseline RUN (Claude + Cursor) is the maintainer's. Adversarial-reviewed (CLAUDECODE-tightened detection, lint-vs-review rubric split, env-branch unit tests).
- *What*: Add the agent tool dimension to the `DELIVERY_METRICS` retro ("what did you fight — and which agent?"); split time-to-module by tool via the already-shipped `scaffold` breadcrumb; formalize the manual G4 eval into a written rubric and run a first baseline across Claude + Cursor.
- *Why now*: you've proven input parity (synced rules); output parity (equal effectiveness) is unverified. Baseline it before apps depend on it.
- *Maps to*: `V4_STATUS` G4; `DELIVERY_METRICS` M4/M6.

**A2-9 — Security external review, timed before portfolio migration** · external · ◐ — **BRIEF SHIPPED** (`d5ea237`): `docs/SECURITY_REVIEW_BRIEF.md` packages the internal audit (`SECURITY_AUDIT_V4.md`) for a third-party firm — pre-migration timing gate (shared-core concentration), threat model, a start-here that keeps the reviewer off the 28 closed findings, in-scope surfaces (OAuth flow · JWT + refresh-cookie rotation · idempotency replay · the A2-1 tenancy model · parse-\* fuzzing) with entry-point pointers, out-of-scope, logistics; reconciled the audit's R1 with the post-audit A2-1 tenancy model. REMAINING: commission the review + gate it before portfolio migration — the maintainer's step (external, like the G2 GA gate in V4_STATUS).
- *What*: Commission the third-party review (state signing, JWT cookie rotation, OAuth surface, idempotency, and the soon-to-exist RLS) and gate it *before* wide v4 adoption.
- *Why now*: concentration — a flaw in the shared security core is a flaw in every public-facing app at once. Find it before ten apps ship on it.
- *Maps to*: `V4_STATUS` G2 (re-prioritize timing to pre-migration).

## Phase 3 — Sustainability + decoupling (Alpha 2 → GA)

**A2-10 — "Every breaking change ships a codemod" norm** · S · ☐
- *What*: Document the standing norm + a codemod template; lean on the `migrate-orm` muscle you already built.
- *Why now*: turns the concentration bet (all apps on one stack) from scary into safe — upgrades become mechanical, not archaeological.

**A2-11 — Decouple release cadence by volatility** · M · ☐
- *What*: Move the churny, externally-coupled adapters (LLM providers, OAuth providers, cloud-storage SDKs) into separately-versioned `libraries/`; the stable core depends on interfaces, not on their release clock.
- *Why now*: a v3 driver you've reaffirmed for v4. Keeps the core boring and stable while volatile adapters move independently. Overlaps AI-A3.

**A2-12 — Standardize telemetry + error-code schema** · M · ☐
- *What*: Fix OTel semantic conventions (span names/attributes) and structured error codes in the framework before apps customize them.
- *Why now*: every app emits OTel; divergent schemas make portfolio-level observability and the M5 defect-by-layer metric impossible. Uniform now = cross-app dashboards for free.
- *Maps to*: complements `DELIVERY_METRICS` M5.

## Phase 4 — DX polish (lowest stakes; none of it locks in)

**A2-13 — First-run DX** · S · ☐
- *What*: Generate `OAUTH_STATE_SECRET` in `ship-api create`; offer an auth-provider choice instead of shipping it commented-out; emit real diagnostics (DB reachable? migrations pending?) when `ship-api dev`'s health probe times out.

---

# Part II — AI library refinement (`libraries/ai`)

**Principle**: abstraction altitude should be inversely proportional to substrate volatility. AI is the fastest-moving substrate in the stack, so standardize the *durable* surfaces and keep the *volatile* ones thin and swappable. AI is strongly pulled (every app uses it, inconsistently) — the question is altitude, not whether. The `libraries/` decoupling (A2-11 / AI-A3) is what makes getting this partly wrong non-catastrophic.

## Remove / thin (do in Alpha 2 — these are breaking, so they belong in the alpha window)

**AI-R1 — Keep the multi-provider seam; make it pass-through, not lowest-common-denominator** · M · ☑ — **DONE** (`7f66aca`): the seam accepted `providerOptions` inbound but discarded native features outbound — now `CompleteResult`/`StreamStopEvent` carry `raw`+`providerExtras` and `TokenUsage` carries `reasoningTokens`+`raw`, both adapters populate them (Anthropic thinking/citations; OpenAI refusal/reasoning), and the `providerOptions`/`metadata` drop in agentLoop + retrieveAndAnswer is fixed. Additive-optional; adversarial-reviewed. (Optional native-`completeStructured` provider method = non-speculative follow-on.)
- *Resolved (A2-0)*: apps genuinely multi-provider (Anthropic + OpenAI + Gemini), so the cross-provider seam is **justified** — keep it. The risk was never the abstraction's existence; it's LCD-flattening.
- *What*: let provider-native features (prompt caching, extended thinking, citations, native structured output, Gemini specifics) pass **through** the seam rather than be abstracted away. Thin only where it flattens, not the whole layer.

**AI-R2 — Demote `agentLoop` to a thin/experimental helper** · S · ☑ — **DONE** (`611886a`, breaking): `agentLoop` moved off the stable barrel to `@sixthsummit/ship-api/libraries/ai/experimental` (`@experimental`, no stability promise — superseded-by-MCP risk); `defineTool`/`toolRegistry` stay stable. Zero in-repo consumers broke.
- *What*: Take the hand-rolled loop off the stable-API surface; mark experimental. The ecosystem (and your agent-native bet) is moving to MCP / provider-native agent loops; this is the piece most likely obsolete in ~18 months.

**AI-R3 — Deprecate `HeuristicTokenizer` / `countMessageTokens`** · S · ☑ — **DONE** (`611886a`): both `@deprecated` (kept exported) — token truth is the provider response `usage` (richer after AI-R1); added thin `estimateTokens`/`estimateMessageTokens` for pre-call budgeting. The `Tokenizer` interface stays (durable seam).
- *What*: Replace heuristic token counting with *actual* usage data returned by provider responses (feeds AI-A1). Keep at most a thin pre-call estimate helper.
- *Why*: heuristic counts are inaccurate and a maintenance burden (schemes change per model); the truth comes back in the response.

## Enhance (the durable parts that already exist)

**AI-E1 — Make the Weaviate + chunking RAG pipeline the flagship golden path** · M · ☐
- *What*: Harden and document the `retrieveAndAnswer` + `VectorStore` path with Weaviate as the first-class default; this is your *strongest* standardization candidate because the infra is already committed and retrieval consistency compounds and ages slowly.

**AI-E2 — Keep and harden `definePrompt` (versioned prompts)** · S · ☐
- *What*: Confirm it on the stable-API surface; add hooks so prompts can be evaluated (ties to AI-A2). Sensible and durable — lean in.

## Add (durable, currently missing)

**AI-A1 — `LLMUsageTracker` (cost / usage / latency observability)** · M · ☐
- *What*: Pluggable backend (in-memory / Prometheus / Postgres), hooked into the provider seam, OTel-integrated, uniform across apps.
- *Why now*: the most portfolio-valuable, slowest-aging AI surface there is — and it's currently *deferred*. That's backwards.
- *Maps to*: promote `V4_STATUS` P5 from deferred-polish to a Part-II priority.

**AI-A2 — AI eval / quality harness** · L · ☐
- *What*: Golden sets, LLM-as-judge, regression gates in CI. The biggest gap in the surface.
- *Why now*: the scariest inconsistency in roll-your-own AI isn't plumbing — it's not knowing whether features *work* or regressed on a model/prompt bump. For a shop shipping AI to clients, this is the highest-value AI standardization and the safety net for the model-upgrade treadmill.

**AI-A3 — Separately version `libraries/ai`** · S–M · ☑ — **DONE** (`a8f9d08`): libraries are copied-in reference source, so → a meaningful `library.json#version` (bumped 0.1.0→0.2.0 for R1/R2/R3, independent of core's 4.0.0-alpha.2) + `ship-api add -l` stamps `src/lib/<name>/.ship-lib.json` (durable, diffable for `ship-api update`) + `CHANGELOG.md` + a README versioning rule. Not a separate npm package (would invert the copied-in model).
- *What*: Version the AI library independently of core (instance of A2-11), so it can churn without bumping the stable framework.

**AI-A4 — Gemini LLM adapter** · S–M · ☐
- *What*: Add a Gemini adapter to the provider seam — surfaced by A2-0 (apps use Gemini; only Anthropic + OpenAI adapters exist today). Doubles as the third-provider validation that the seam (AI-R1) isn't secretly two-provider-shaped.
- *Maps to*: pull-audit finding (A2-0).

---

# Sequencing & Alpha 2 exit criteria

| ID | Item | Phase | Size | Status |
|----|------|-------|------|--------|
| A2-0 | Pull audit | 0 | S | ☑ done |
| A2-1a.0 | Module system first-class — unit-test gate (reference-source) | 1 | M | ☑ done |
| A2-1a | Identity/RBAC → modules; retire `defaultSchema` (+ integration runner, template fix) | 1 | M–L | ☑ done (c1–c4) |
| A2-1a.1 | Derive repo test deps from manifests | 3 | S | ☐ |
| A2-1b | Module auto-wiring (codegen; v3 parity) | 3 | M | ☐ |
| A2-1 | Tenancy as opt-in primitive | 1 | M | ☑ done (`c54f7d1`) |
| A2-2 | Contract freeze pass | 1 | M | ☑ done (`65c2dc4`) |
| A2-3 | `QueryFilter` rename | 1 | S | ☑ done (`65c2dc4`) |
| A2-4 | Version/release plumbing | 1 | S | ☑ done (`f6e2992`) |
| A2-5 | SemVer + deprecation contract | 1 | S | ☑ done (`f6e2992`) |
| A2-6 | v3↔v4 parity fixtures | 2 | L | ◐ started (`fe2dd84`); v3 capture pending |
| A2-7 | Drizzle hedge lint guard | 2 | S–M | ☑ done (`f5b0828`) |
| A2-8 | Agent output-parity baseline | 2 | S–M | ☑ done (`3df355c`); baseline run pending |
| A2-9 | Security review (pre-migration) | 2 | ext | ◐ brief (`d5ea237`); commission pending |
| A2-10 | Codemod-per-break norm | 3 | S | ☐ |
| A2-11 | Decouple release by volatility | 3 | M | ☐ |
| A2-12 | Telemetry/error schema | 3 | M | ☐ |
| A2-13 | First-run DX polish | 4 | S | ☐ |
| AI-R1 | Multi-provider seam → pass-through (not LCD) | 1 (AI) | M | ☑ done (`7f66aca`) |
| AI-R2 | Demote `agentLoop` | 1 (AI) | S | ☑ done (`611886a`) |
| AI-R3 | Deprecate heuristic tokenizer | 1 (AI) | S | ☑ done (`611886a`) |
| AI-E1 | Weaviate/chunking RAG golden path | 3 (AI) | M | ☐ |
| AI-E2 | Harden `definePrompt` | 3 (AI) | S | ☐ |
| AI-A1 | `LLMUsageTracker` | 3 (AI) | M | ☐ |
| AI-A2 | AI eval harness | 3 (AI) | L | ☐ |
| AI-A3 | Separately version AI lib | 3 (AI) | S–M | ☑ done (`a8f9d08`) |
| AI-A4 | Gemini LLM adapter | 3 (AI) | S–M | ☐ |

**Cut Alpha 2 when** (the irreversible set is locked):
- ☑ A2-0 pull audit done (scope decided) — RESOLVED 2026-05-30
- ☑ **Phase 1 complete**: A2-1 … A2-5 (contracts + norms locked) — `f6e2992`
- ☑ AI volatile parts thinned: AI-R1, AI-R2, AI-R3 — `7f66aca` + `611886a`
- ☑ AI library independently versioned: AI-A3 — `a8f9d08`
- ☑ A2-6 parity harness *started* (`fe2dd84`; real v3 capture is the maintainer's step)

**→ All criteria met: the irreversible/breaking set is locked. Alpha 2 is ready to cut.**

**Everything else runs Alpha 2 → GA** and is additive (non-breaking) by construction.

# Open questions (decide as we iterate)

1. ~~**Tenancy column** (A2-1)~~ — **RESOLVED 2026-05-30**: one-tenant-per-user; `tenantScoped` mixin (`tenant_id uuid not null → tenants.id`), separate from `baseFields`; active tenant resolved via `RequestContext` (keeps A→B cheap); RBAC stays global. Full spec in A2-1.
2. ~~**Provider portability** (AI-R1)~~ — **RESOLVED 2026-05-30 (A2-0)**: genuinely multi-provider (Anthropic + OpenAI + Gemini). Keep the seam, make it pass-through (not LCD). Gemini adapter is missing → AI-A4.
3. **Upgrade model** (A2-5): pinned-and-bumped vs floating across the portfolio.
4. **Eval harness scope** (AI-A2): framework-provided harness vs a documented pattern apps adopt; which app is the first reference eval.
5. **Reconcile into `V4_STATUS`**: fold these IDs into the master tracker, or keep this as the working doc until items land?
