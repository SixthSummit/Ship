# G2 — External Security Review Brief

> **Audience**: the third-party security firm commissioned for the G2 review, and the maintainer commissioning it.
> **Status**: commissioning brief. The internal first-pass audit ([`SECURITY_AUDIT_V4.md`](SECURITY_AUDIT_V4.md)) is the **primary input** — read it first. This brief scopes the engagement on top of it.
> **Companion**: [`V4_STATUS.md`](V4_STATUS.md) G2 (the GA gate) · [`.cursor/rules/security.mdc`](../.cursor/rules/security.mdc) (the security conventions consumers inherit).

## Why this review, and why now

ShipAPI is a backend framework that **standardizes delivery across a portfolio of public-facing, multi-tenant SaaS apps**. That creates a concentration property the threat model turns on: **a flaw in the shared security core is a flaw in every app built on it, at once.** The leverage that justifies the framework is also its blast radius.

So the timing is the point of A2-9: **commission and clear G2 *before* wide v4 portfolio adoption**, not after. Once N apps ship on the shared core, a core-level finding is N incident responses; found now, it's one fix that protects all of them (the inverse of `DELIVERY_METRICS` M2). Treat G2 as a **pre-migration gate**, not a post-GA formality.

## Threat model (calibrate findings to this)

Take the calibration verbatim from [`SECURITY_AUDIT_V4.md` → How to read this doc](SECURITY_AUDIT_V4.md#how-to-read-this-doc):

- **Public-facing, multi-tenant SaaS, hostile internet.** The severity floor: *any* finding exploitable by an **anonymous attacker against a consumer's public app is Critical/High**, even if it would be "informational" for an internal tool.
- **Cross-tenant breach is a top-tier impact** — an authenticated attacker pivoting to another tenant's data ranks with anonymous account takeover.
- The framework is also **adopted externally**, so consumer-footgun defaults (insecure-by-omission) count as findings — the framework should be safe by default, not safe only when configured perfectly.

## Start here — don't re-find what's closed

The internal audit already found and **closed 28 findings** (2 Critical, 7 High, 11 Medium, 8 Low) and enumerates **22 verified strengths**. Your time is best spent on **novel surface and validating the fixes**, not re-deriving the known set. Concretely:

1. **Validate the P0/P1/P2 fixes actually close the finding** (not just the cited line) — spot-check the regression tests named under each finding, and grep for sibling instances the fix missed. The closure SHAs are in `V4_STATUS.md` G2.
2. **Review the 22 "Verified strengths"** ([audit §Verified strengths](SECURITY_AUDIT_V4.md#verified-strengths-enumerated-for-g2-reviewer-calibration)) — confirm they hold under adversarial conditions rather than re-deriving them cold (e.g. the constant-time compares, the refresh-token chain-revocation CTE, ES256 algorithm-confusion defense, the fail-closed rate limiter).
3. **Extend to the surfaces the internal pass explicitly deferred to you** (audit §Out of scope, §Watchlist) — these are where novel findings most likely live.

## In-scope surfaces (priority order)

The named surfaces for this engagement, each with where it lives and what to probe. (Per-finding detail + line ranges are in the audit; pointers below are the entry points.)

1. **OAuth flow — provider-specific & end-to-end.** `modules/oauth/` (`routes.ts`, `state.ts`, `stateJtiCache.ts`, `verifyIdToken.ts`, the provider adapters). The internal pass covered open-redirect (F1), PKCE (F12), id_token nonce (F13), state replay within the signature window (F16, now JTI-cached). **Extend to:** provider-specific known attacks (per-IdP quirks), the unauthenticated callback's state-signature-as-sole-binding (audit §Watchlist), and a full flow trace against the OAuth/OIDC threat catalog. The state signing uses a rotation set with a constant-iteration verify loop — confirm no key-match timing leak and no downgrade across the rotation set.
2. **JWT issuance + refresh-token cookie rotation.** `packages/core/src/app/auth/jwt/` (`JwtSigner.ts`, `AuthFlow.ts`, `RefreshTokenStore.ts`, `DrizzleRefreshTokenStore.ts`) + `http/utils/authCookies.ts`. ES256 hardcoded (no `alg` confusion), `kid` rotation, refresh tokens stored as SHA-256 hashes with **chain-revocation on reuse** (recursive CTE). **Probe:** rotation/reuse races (concurrent refresh), the CTE's behavior on pathological chains (audit §Watchlist), cookie attributes + the `domain` footgun (F5), and clock-tolerance handling (F9, now 30s).
3. **Idempotency replay.** `http/middleware/idempotency.ts`. `setIfAbsent` atomicity is a load-bearing invariant (F19); `AppError` responses are persisted (failures are idempotent). **Probe:** replay/race windows, key-collision across tenants (F10 — the `scope:"global"` default is a **pre-agreed deferral to V8**, not an open finding to re-report), and the atomicity invariant under a contended backend.
4. **Tenancy / cross-tenant isolation model.** **Changed since the audit (which predates it):** A2-1 (`c54f7d1`) shipped the opt-in tenancy primitive — `tenantScoped(tenants)` column mixin (`packages/core/src/app/db/tenantScoped.ts`) + `resolveTenant()` middleware (`http/middleware/resolveTenant.ts`) + `RequestContext.tenantId` (`app/context/RequestContext.ts`), all barrel-exported. This **supersedes the audit's R1** ("no multi-tenancy primitives"), which is now stale. **Enforcement (RLS / auto-scoping) is still deferred to V8** — the primitive ships the *column shape + resolution convention*, not a guarantee. **Assess the model**: is the convention sound enough that consumers adopting it now won't build cross-tenant leaks, and does the deferred-enforcement gap need a louder warning? Stress-test AsyncLocalStorage request-context propagation for `tenantId`/`accountId` leaking across awaits under adversarial async interleaving (audit §Watchlist).
5. **Input-parsing fuzzing.** `http/utils/parseWebhook` + `parseUpload` (`webhooks.ts`, `uploads.ts`) — the audit explicitly asks for a **structured fuzzing pass** here. MIME-detection bypass (F20), raw-body integrity (a strength), invalid-JSON handling (F18).

Secondary (covered internally; confirm, don't re-derive): CSRF (`csrf.ts`), rate-limit (`rateLimit.ts` — IP-spoofing F2, fail-closed), API-key compare (`apiKey.ts`), storage path-traversal/symlinks (`DiskStorageAdapter.ts`, signed-URL TTL).

## Explicitly out of scope

Per [audit §Out of scope](SECURITY_AUDIT_V4.md#out-of-scope): third-party dependencies (gated by `audit-ci` hard-fail on high/critical), consumer business logic, and infrastructure (TLS, k8s RBAC, secret managers, network policy). **Deferred (note, don't treat as findings):** R1 multi-tenancy RLS enforcement (V8 — but the A2-1 *model* above IS in scope), R2 outbound-webhook signing (V4.x), F10 idempotency tenant-scoping (rides on V8).

## Engagement logistics

- **Test target:** a clean `npx ship-api create` app (the `packages/core/templates/default` reference) is the realistic deployment shape; the framework itself (`@sixthsummit/ship-api`) is the code under review. The MCP `execute_route` tool drives routes through the real middleware chain.
- **Deliverable:** findings in the audit's per-finding shape (File + line / Severity at this threat model / Exploitability / Impact / Suggested fix / suggested regression test), severity-calibrated to the model above, plus a short executive risk summary. New findings should slot into the existing P0/P1/P2 tiering.
- **Disclosure:** responsible disclosure to the maintainer per [`SECURITY.md`](../SECURITY.md); no findings published before remediation.
- **Gate:** this review must reach **no open Critical/High** (or accepted-risk sign-off on each) **before** the portfolio migrates onto v4 at scale. Track closure as G2 sub-bullets in `V4_STATUS.md`, mirroring the internal P0 checklist.
