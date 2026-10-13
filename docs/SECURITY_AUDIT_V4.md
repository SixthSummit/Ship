# ShipAPI v4 — Internal Security Audit

> **Audience:** framework contributors · external G2 reviewer · external adopters auditing pre-deploy
> **Status:** first-pass internal review · 2026-05-10 · informs G2 commissioning
> **Threat model:** PUBLIC-FACING multi-tenant SaaS; framework also sold externally
> **Severity floor:** any finding affecting anonymous attackers against a consumer's public app is **P0**

## TL;DR

- **28 findings**: 2 Critical, 7 High (collectively **9 P0**, pre-GA blockers) · 11 Medium (**P1**, next-minor hardening) · 8 Low (**P2**, polish)
- **Threat model recalibration drove most severity changes.** Several first-pass findings flagged "Informational" or "Medium" under an internal-tool reading escalated to **High** or **Critical** once we re-anchored to public-facing + multi-tenant + external-adoption. The most consequential reclassifications are F1 (OAuth open redirect) → Critical, F2 (XFF spoofing) → Critical, F4 (CORS not wired) → High, F5 (cookie domain unvalidated) → High, F6 (DiskStorage symlinks) → High.
- **Verified strengths section is non-trivial** — 18 concrete defenses are already in place (constant-time compares, refresh-token hash storage with chain revocation, ES256 + kid rotation, fail-closed rate limiter, audit-ci gating). G2 should review these strengths to avoid re-deriving them cold.
- **Roadmap-level findings**: no first-class multi-tenancy primitives (V8 in `V4_STATUS.md`) and no outbound-webhook signing (V4). Several P1 findings compound these absences and should be re-evaluated when the deferred work lands.

## How to read this doc

### Severity legend (calibrated to this threat model)

| Tier | Meaning |
|---|---|
| **Critical** | Anonymous attacker against a consumer's public-facing app can chain into account takeover, data exfil, or cross-tenant breach. |
| **High** | Anonymous attacker can exploit under common deployment configs, OR an authenticated attacker can pivot to cross-tenant access. |
| **Medium** | Exploitable only with specific (uncommon) misconfigurations or insider context. Usually consumer footguns the framework should defensively block. |
| **Low** | Code-quality / defense-in-depth gap with no practical exploit path at the current shape. |
| **Informational** | Already mitigated; documented here for the G2 reviewer's calibration. |

### Per-finding shape

Each finding records:
- **File:** path with line range — open the file and trace the cited block
- **Severity** at this threat model
- **Exploitability:** who triggers it, what preconditions
- **Impact:** what they get (account / data / cross-tenant / DoS / etc.)
- **Suggested fix:** one sentence — the design direction, not a literal diff
- **Verification:** the regression test that proves closure

### How threat model affects severity

A finding's severity here is **NOT a CVSS score** and would re-calibrate for different deployments:
- **Internal trusted tooling** (no anonymous traffic, no multi-tenancy): F1 → Medium, F2 → Medium, F5 → Low.
- **Public-facing single-tenant**: F1 → Critical, F2 → Critical, F5 → Medium.
- **Public-facing multi-tenant** (this doc's bar): F1 → Critical, F2 → Critical, F5 → High.

Adopters with different threat models should recalibrate; the per-finding "Exploitability" section explains the chain so recalibration is mechanical.

---

## P0 — pre-GA blockers (must land before G2 review)

### F1. OAuth `returnTo` open redirect on a trusted-OAuth domain

- **File:** `modules/oauth/routes.ts:248` (input declared at `:104`, signed into state at `:172`)
- **Severity:** **Critical**
- **Exploitability:** Anonymous attacker crafts a phishing link that points at the consumer's authorize endpoint with `returnTo=https://attacker.example.com/?session=<placeholder>`. Victim clicks, authenticates legitimately (recognizes the consumer's domain), and is 302'd to the attacker after a real session is established. The framework-signed state defeats *tampering* but the original `returnTo` value is unvalidated user input (`z.string().optional()` at `:104`).
- **Impact:** Phishing chain originating on the consumer's trusted login domain. Captured credentials (if the attacker page replays login) or session cookies (if the attacker page is loaded in a context that can read them via XSS elsewhere).
- **Suggested fix:** Schema-level URL validation + allowlist enforced *before* signing. Allow relative paths matching `^/[^/]` only (same-origin), or absolute URLs whose origin matches a consumer-supplied allowlist passed in `OAuthRoutesDeps`. Reject `javascript:`, `data:`, protocol-relative `//`, and scheme-relative redirects unconditionally.
- **Verification:** Regression test that asserts `POST /oauth/:providerCode/authorize` with `returnTo: "https://attacker.com"` returns 400. Second test: a path-traversal `returnTo: "//attacker.com"` returns 400. Third test: relative path `/dashboard` succeeds; the callback redirects to `/dashboard` only.
- **Resolved:** `53e5ae7` — `validateReturnTo()` enforces same-origin relative paths or `returnToAllowlist`-matched absolute URLs; rejects `javascript:` / `data:` / `vbscript:` / `file:` schemes, protocol-relative `//`, backslash-host `/\\`, and CRLF/NUL injection. Runs at authorize (primary) + callback (defense in depth). 10 new tests in `modules/oauth/routes.test.ts`.

### F2. Rate-limit IP spoofing via unvalidated `X-Forwarded-For`

- **File:** `packages/core/src/http/middleware/rateLimit.ts:73-76`
- **Severity:** **Critical**
- **Exploitability:** `defaultKeyGenerator` reads the first comma-segment of `X-Forwarded-For` with no `trustProxy` allowlist. On a public app behind any CDN or load balancer that doesn't strip XFF, an anonymous attacker rotates XFF values (e.g., `X-Forwarded-For: 1.2.3.4` per request) to bypass per-IP login, signup, password-reset, OAuth-state-burn, or webhook-replay rate limits. This is the single most common path to credential stuffing succeeding at scale.
- **Impact:** Unbounded brute-force on any unauthenticated rate-limited endpoint. With a 30M-leaked-credentials list, an attacker can ~30M requests in a few hours and the per-IP rate limit cannot stop them.
- **Suggested fix:** Add a `trustProxy: string[]` (CIDR list) option to `rateLimit()` and `createApp()`. Implement rightmost-untrusted-IP algorithm (walk XFF right-to-left, stop at the first IP not in the trust list, use that as the client IP). Reject XFF entirely when the immediate peer isn't in the allowlist; default to **host-only** (no XFF trust) when unset. Document the deployment-time config loudly in `.cursor/rules/security.mdc` and the consumer template should set this explicitly with the operator's known CDN/LB ranges.
- **Verification:** Regression test with `trustProxy: []` asserts that `X-Forwarded-For: 1.2.3.4, 5.6.7.8` is ignored and the peer IP is used. Test with `trustProxy: ["10.0.0.0/8"]` and `peer = 10.0.0.5` asserts that XFF is honored. Test with `peer = 8.8.8.8` (untrusted) and any XFF asserts that XFF is rejected.
- **Resolved:** `1d3d505` — `trustProxy: readonly string[]` CIDR option + `resolvePeerIp` callback added to `RateLimitOptions`. `resolveClientIp()` in `packages/core/src/http/utils/clientIp.ts` runs the rightmost-untrusted-IP walker with inline IPv4 + IPv6 CIDR parsing (IPv4-mapped IPv6 normalized). 12 new tests in `rateLimit.test.ts` cover the algorithm end-to-end. `.cursor/rules/security.mdc` documents the deployment-time requirement.

### F3. Storage signed-URL TTL unbounded — multi-tenant cross-tenant exposure

- **File:** `packages/core/src/app/services/storage/S3StorageAdapter.ts:174-187` · `GCSStorageAdapter.ts:148-159` (similar)
- **Severity:** **High**
- **Exploitability:** Consumer (or a copy-pasted Stack Overflow snippet) passes `expiresInSec: 31536000` (a year). The URL is valid for that entire window, surviving session revocation, role changes, and tenant migrations. If the URL leaks (logs, share-link UX, analytics, browser history forwarded to support), the object is readable by anyone who has the link for up to a year.
- **Impact:** Cross-tenant object exfiltration whenever URLs are shared or logged. In a multi-tenant deployment hosting tenant assets, this is data leakage with no audit trail.
- **Suggested fix:** Validate `expiresInSec` against a `maxExpiresInSec` ceiling (default 24h, configurable per adapter constructor). Throw a `BadRequestError` on overflow. Document the ceiling in `SignedUrlOptions` JSDoc and the storage README; explain the multi-tenant rationale.
- **Verification:** Regression test for both adapters: `signedUrl(key, { expiresInSec: 86400 })` succeeds; `signedUrl(key, { expiresInSec: 86401 })` with default ceiling throws. Test that consumer-supplied `maxExpiresInSec: 3600` is honored.
- **Resolved:** `d2fe9d2` — `maxExpiresInSec?: number` added to both adapter constructor options (default 86 400). `signedUrl()` throws `BadRequestError` when TTL is out of range. JSDoc on `SignedUrlOptions.expiresInSec` documents the multi-tenant rationale. 14 new tests across S3 + GCS test files.

### F4. CORS not wired by `createApp`; no safe template pattern

- **File:** `packages/core/src/http/app/createApp.ts` (no CORS plumbing) · `packages/core/templates/default/src/index.ts` (no CORS example)
- **Severity:** **High**
- **Exploitability:** External adopters will reach for `hono/cors` with `origin: '*'` + `credentials: true` — an impossible combination that browsers SHOULD reject but that nonetheless ships in many tutorials and gets accidentally permissive. Without framework-level guidance, the first cohort of public-facing apps built with the framework will be CSRF-bypass-able through CORS misconfig.
- **Impact:** CSRF defense bypass on any consumer app that misconfigures CORS. Combined with `httpOnly: false` CSRF cookies (the framework's intentional double-submit pattern), attacker pages can drive arbitrary authenticated requests.
- **Suggested fix:** Add a `cors?: CorsOptions` parameter to `createApp` that wires `hono/cors` with safe defaults (env-driven `corsOrigin: string[]` allowlist; reject wildcard + credentials combination at config time with a thrown error). Ship the consumer template with the validated pattern wired. Add a `ship-api g doctor` check that fails on `origin: '*'` + `credentials: true` if `hono/cors` is detected in `package.json`.
- **Verification:** Regression test: `createApp({ cors: { origin: "*", credentials: true } })` throws at config time. Test: `createApp({ cors: { origin: ["https://app.example.com"], credentials: true } })` produces the right CORS headers. Doctor test: a fake consumer config triggers the warning.
- **Resolved:** `1e0a27c` — `cors?: CorsOptions` added to `CreateAppOptions`. `hono/cors` mounted as global middleware (no new dep — comes via `hono`). Wildcard + credentials combinations rejected at construction. Consumer template wires `CORS_ORIGINS` env-driven allowlist. `.cursor/rules/security.mdc` documents the pattern. 8 new tests in `createApp.test.ts`. The `g doctor` warning is deferred to P1/P2 polish — the construction-time throw is the load-bearing defense.

### F5. Cookie `domain` option unvalidated

- **File:** `packages/core/src/http/utils/authCookies.ts:49-50` (where `AuthCookieConfig.domain` is declared)
- **Severity:** **High**
- **Exploitability:** Consumer sets `domain: ".com"` or any public suffix (e.g., `".co.uk"`); the auth cookie attaches to *every* TLD subdomain. In a multi-tenant deployment hosted at `*.app.com`, an overly broad domain like `".app.com"` is correct, but `".com"` leaks the cookie to every site the user visits. Even within `.app.com`, an overly broad domain leaks sessions across customer subdomains.
- **Impact:** Cross-tenant session takeover when a user logs into tenant A, then visits tenant B (same domain leaf). Cookie travels and tenant B's app receives a valid-looking session for tenant A's user. With shared infrastructure this is a tenant-isolation breach.
- **Suggested fix:** Validate `domain` against the public suffix list (use `tldts` or a hard-coded common-suffix table). Throw at config time on overly broad values. The framework's default (no `domain` set → host-only cookies) is correct; the validation defends consumers who override it. Document the per-tenant subdomain pattern in the template README.
- **Verification:** Regression test: `AuthCookieConfig({ domain: ".com" })` throws. Test: `domain: ".co.uk"` throws. Test: `domain: "app.example.com"` accepted; `domain: ".example.com"` accepted (one level above eTLD+1). Test: no domain set → host-only cookies (unchanged behavior).
- **Resolved:** `474a8a0` — conservative eTLD table in `packages/core/src/http/utils/publicSuffix.ts` (~120 entries covering gTLDs / ccTLDs / common multi-label eTLDs). `checkCookieDomainAgainstPublicSuffix()` runs in `resolveConfig` (authCookies) AND in `csrf()` middleware construction (also accepts `cookie.domain`). Throws with a fix-suggesting message. Future swap-in for `tldts` is a P1/P2 follow-up.

### F6. DiskStorageAdapter doesn't `realpath()` to defeat symlinks

- **File:** `packages/core/src/app/services/storage/DiskStorageAdapter.ts:54-67`
- **Severity:** **High**
- **Exploitability:** The three-layer string-based path-traversal check is sound for plain `../` attacks but doesn't follow symlinks. If a consumer's tenant-isolated upload directory contains (or admits via separate upload) a symlink pointing outside `rootDir`, subsequent reads/writes traverse the symlink and escape isolation. Multi-tenant deployments with shared filesystems (e.g., NFS, shared k8s volumes) are vulnerable to one tenant's symlinks accessing another tenant's data.
- **Impact:** Cross-tenant filesystem read/write. Most acute on early-stage or self-hosted deployments where filesystem isolation isn't enforced at the OS layer.
- **Suggested fix:** Call `fs.realpath()` on the resolved path before any I/O operation; reject (`BadRequestError` or `NotFoundError`) when the realpath escapes `rootDir`. Cache realpath results per request to avoid stat overhead on hot paths.
- **Verification:** Regression test: create a temp `rootDir`, inside it create a symlink pointing outside, attempt to `get(symlinkKey)` and assert it throws. Test that legitimate files still work. Test that symlinks pointing within `rootDir` (relative symlinks) are still followed correctly.
- **Resolved:** `e2b655d` — `resolveKeySafe(key)` walks up to the deepest existing ancestor and `realpath`s it (with `lstat`-based existence detection + `readlink` fallback for dangling symlinks). `realRoot` cached. Applied to `put`/`get`/`exists`/`delete`/`list`. 11 new tests cover leaf + directory + dangling + inside-root + new-key + symlinked-rootDir cases.

### F7. MCP `execute_route` accepts agent-supplied `baseUrl`; no localhost guard

- **File:** `packages/mcp-server/src/server.ts:180,185`
- **Severity:** **High**
- **Exploitability:** Dev-time-only tool (stdio MCP, not HTTP-exposed), but: (a) `args.baseUrl` is agent-controlled per call; (b) `SHIP_API_DEV_URL` env defaults to `http://localhost:3000` but can be overridden; (c) external adopters using AI-assisted development pipelines can have an LLM agent redirect `execute_route` at production. Combined with a developer's locally cached production auth header, this drives live mutations from the dev workflow.
- **Impact:** Accidental or LLM-driven production traffic. Worst case: an agent suggests "let me re-run that with the prod URL to verify the fix" and mutates real data.
- **Suggested fix:** Localhost-only enforcement by default — reject `args.baseUrl` and `SHIP_API_DEV_URL` values that don't resolve to a loopback address. Require explicit `SHIP_API_MCP_ALLOW_REMOTE=1` env opt-in to target non-loopback hosts. When opt-in is set, log every non-loopback call to stderr with the resolved host. Update tool description in `server.ts` to surface this behavior prominently. Add a paragraph to `packages/claude-plugin/README.md`.
- **Verification:** Regression test (in MCP server): `execute_route` with `baseUrl: "https://prod.example.com"` returns `{ reason: "remote-not-allowed" }` by default. Same call with `SHIP_API_MCP_ALLOW_REMOTE=1` succeeds (mocked HTTP layer). Test that `localhost`, `127.0.0.1`, `::1`, and `0.0.0.0` are accepted without opt-in.
- **Resolved:** `5d12729` — `packages/mcp-server/src/util/isLoopback.ts` (pure-string classifier, no DNS round-trip). `executeRoute()` returns `reason: "remote-not-allowed"` for non-loopback `baseUrl` unless `SHIP_API_MCP_ALLOW_REMOTE=1` is set. Audit-logs every non-loopback call to stderr. Tool description in `server.ts` surfaces the constraint. Plugin + MCP server READMEs both document the opt-in. 10 new tests cover the refused-call path, the opt-in path with audit-log capture, each loopback form, and `127.0.0.1.nip.io` / link-local rejection.

### F8. `defineEnv` failure handler doesn't scrub potential secret values

- **File:** `packages/core/src/app/utils/defineEnv.ts:52-67`
- **Severity:** **High**
- **Exploitability:** Framework default messages are safe — Zod's built-in messages (e.g., "String must contain at least 32 character(s)") don't echo the value. But consumer schemas using `.refine((v) => ..., { message: \`got "${v}"\` })`, or transform-based validators that include the raw value, will dump it to `console.error` in `defaultOnFailure`. Observability stacks (Stackdriver, Datadog, Loki) capture stdout/stderr by default; the secret is now searchable and forwarded.
- **Impact:** Secret leak via startup logs → forced rotation event, plus blast-radius scoping (what else did that secret unlock).
- **Suggested fix:** In `defaultOnFailure`, regex-scrub message segments matching known secret-value patterns before logging — long base64/hex strings (>20 chars), `sk-[A-Za-z0-9]+`, `xoxb-…`, JWT-shaped tokens (`eyJ…`), AWS access keys (`AKIA…`). Replace matches with `<redacted>`. Add a `CONTRIBUTING.md` note: "avoid `${v}` interpolation in `.refine` messages — even with the framework's defensive scrub, prefer schema-level constraints that don't require the value in the error message."
- **Verification:** Regression test: a schema with `.refine((v) => v.startsWith("sk-"), { message: \`got "${v}"\` })` and a failing value `sk-test_realsecretwouldgohere_123` triggers a log line containing `<redacted>`, not the literal value. Test that legitimate non-secret messages pass through.
- **Resolved:** `8c34c4e` — `scrubSecrets()` exported from `defineEnv.ts` runs five ordered regex passes (JWT, `sk-…`, `xox…`, `AKIA…`, generic high-entropy ≥32 chars). Applied to each Zod `issue.message` inside `defaultOnFailure`. Framework-default Zod messages survive untouched. `CONTRIBUTING.md` adds a "Writing `defineEnv` schemas" section recommending schema-combinator constraints over `.refine(v => …, message: \`${v}\`)`. 7 new tests in `defineEnv.test.ts`.

### F9. JWT `clockToleranceSec` defaults to 0

- **File:** `packages/core/src/app/auth/jwt/JwtSigner.ts:68,132`
- **Severity:** **High**
- **Exploitability:** Not a direct security flaw, but the strict default rejects valid tokens under clock skew between consumers' service hosts (NTP drift of even 1 second causes intermittent 401s). External adopters' first encounter with the framework will be flaky auth they "fix" by widening the window in their own fork or by passing a multi-minute tolerance — losing the strictness benefit and possibly weakening it more than necessary. The framework should ship a battle-tested default rather than a strictness floor that adopters must edit.
- **Impact:** Operational instability under the default, leading to adopter-driven misconfiguration of the security-relevant tolerance.
- **Suggested fix:** Raise default to 30 seconds (industry-standard tolerance; still tight enough to defend against meaningful replay). Document the choice and the override path for strict-mode consumers. Reference NIST SP 800-63B's clock-skew guidance.
- **Verification:** Regression test: a token issued at `t` and verified at `t + 25s` (token TTL = 0) succeeds with the default tolerance. Test that `t + 35s` fails. Test that explicit `clockToleranceSec: 0` reproduces the strict behavior.
- **Resolved:** `b3cdb0d` — default raised from 0 to 30 in `JwtSigner.ts:142`. JSDoc cites NIST SP 800-63B §5.1.1.2 + explains why the strict default produced flaky 401s. 4 new tests in `JwtSigner.test.ts`. `jwtCookie.test.ts`'s tight-window expiration test updated to pass explicit `clockToleranceSec: 0`.

---

## P1 — next minor (hardening + multi-tenant safety pass)

### F10. Idempotency `scope` defaults to `"global"` — cross-tenant key collision

- **File:** `packages/core/src/http/middleware/idempotency.ts:126`
- **Severity:** **Medium**
- **Exploitability:** Two tenants both POST with `Idempotency-Key: abc` against the same path; if the request bodies hash identically (a plausible collision: same product SKU, same default form values), the second tenant gets the first tenant's response replayed. Authenticated cross-tenant data leak via Stripe-style replay.
- **Impact:** Cross-tenant response leak under idempotent retry semantics. Acute on multi-tenant SaaS that surfaces tenant-A's payment ID, order ID, or webhook payload to tenant B.
- **Suggested fix:** Make `scope` required (no `"global"` default), OR change the default `keyGenerator` to include `tenantId` (when available via AsyncLocalStorage; this couples to the deferred V8 multi-tenancy work). Add a `ship-api g doctor` check warning when consumer config leaves `scope` unset on routes that look multi-tenant.
- **Verification:** Test: `idempotency({ cache })` (no scope) throws (or warns). Test: explicit `scope: "orders:tenantA"` and `scope: "orders:tenantB"` produce separate cache namespaces even with the same `Idempotency-Key`.
- **Deferred to V8 (multi-tenancy primitives).** The audit's first-line fix (`scope` required at construction) is a breaking change for the small alpha-line consumer surface; the second-line fix (default `keyGenerator` includes `tenantId` via AsyncLocalStorage) **requires** the V8 multi-tenancy work that's already deferred to v4.x in `docs/V4_STATUS.md`. Closing F10 now would re-litigate the V8 design decision. Tracked under R1 in this doc and under V8 in `V4_STATUS.md`; this annotation makes the deferral explicit so the G2 external reviewer reads it as a calibration choice, not an oversight. Consumers running on alpha-line v4 should pass an explicit `scope` per `idempotency()` call until V8 lands.

### F11. HTTP logger logs full query string on `path` field

- **File:** `packages/core/src/http/middleware/httpLogger.ts:79`
- **Severity:** **Medium**
- **Exploitability:** Recovery / reset / signed-URL / share tokens passed in query strings (a common consumer pattern despite best practice) land in pino logs and forward to observability. Pino's default redactor scrubs body fields but the `path` field includes the query string as a single concatenated value, slipping past the redact-by-key matcher.
- **Impact:** Tokens leaked to log search; attacker who breaches logs has a window of valid tokens.
- **Suggested fix:** Split `path` (route, no query) from `query` (separate field with per-key redaction). Add a query-string redaction list keyed off known sensitive param names (`token`, `signature`, `key`, `secret`, `sig`, `code`). Document the rule in `.cursor/rules/security.mdc`: "secrets must not travel in query strings; the logger defensively redacts but consumers should not rely on this."
- **Verification:** Test: a request to `/reset?token=abc123` produces a log entry with `path: "/reset"` and `query: { token: "<redacted>" }`. Test: an unrelated query param `?page=1` passes through unredacted.
- **Resolved:** `7874f11` — `parseQueryRedacted()` in `httpLogger.ts` parses `c.req.url`, redacts values whose keys are in a case-insensitive sensitive list (`token`, `sig`, `code`, `state`, `password`, `access_token`, etc.), and emits a separate `query` field next to the existing `path`. Field omitted entirely when there's no query string. `.cursor/rules/security.mdc` documents the contract. 7 new tests in `httpLogger.test.ts`.

### F12. OAuth PKCE absent across all adapters

- **File:** `modules/oauth/adapters/{GoogleOAuthAdapter,MicrosoftOAuthAdapter,GmailOAuthAdapter,OutlookOAuthAdapter}.ts`
- **Severity:** **Medium**
- **Exploitability:** Server-side flow is a confidential client, so PKCE isn't strictly required by OAuth 2.0 (the `client_secret` defends against code interception). OAuth 2.1 makes PKCE mandatory; defense-in-depth even for confidential clients (defends against an attacker who somehow holds the auth code but not the client_secret, e.g., a leaked log entry on the consumer side). With the framework sold externally, adopters using these adapters in public-facing flows benefit from PKCE.
- **Impact:** Marginal under correctly-handled confidential clients; meaningful if `client_secret` is ever exposed (the next finding worth a look).
- **Suggested fix:** Add PKCE generation (`code_challenge` + `code_verifier`) to `OAuthAdapter.buildAuthorizationUrl` and `exchangeCodeForTokens`. Persist the `code_verifier` inside the framework-signed state (same `StatePayload`). Default to `S256`. Backwards-compatible since adapters add the params optionally; providers that don't support PKCE ignore them.
- **Verification:** Test: an adapter's `buildAuthorizationUrl` output includes `code_challenge` and `code_challenge_method=S256`. Test: `exchangeCodeForTokens` includes `code_verifier`. Test: state round-trip preserves the verifier through callback.
- **Resolved:** `77d6895` — `AuthUrlOptions.codeChallenge` + `codeChallengeMethod` and new `ExchangeCodeOptions { codeVerifier? }` extended on the `OAuthAdapter` interface. Routes generate `randomBytes(32).base64url` verifier + SHA-256 challenge, sign verifier into `StatePayload.codeVerifier`. Google + Microsoft adapters emit/consume the params; Gmail + Outlook inherit. MockOAuthAdapter captures opts. 8 new adapter tests + 2 new E2E PKCE round-trip tests.

### F13. id_token nonce not validated (defensive lock-in)

- **File:** `modules/oauth/adapters/GoogleOAuthAdapter.ts:166-193` · `GmailOAuthAdapter` · `OutlookOAuthAdapter`
- **Severity:** **Medium**
- **Exploitability:** Currently no exposure — `getProviderAccountId` fetches `/userinfo` over Bearer auth instead of decoding `id_token`. The risk is future-tense: when an adapter (or a consumer) migrates to id_token for `email_verified` or other claims, missing nonce validation enables id_token replay across flows. Locking in correct OIDC verification (signature + nonce echo from state) before any consumer depends on it prevents a future incident.
- **Impact:** No current attack surface; future-proofing finding.
- **Suggested fix:** Add a (currently-unused) `verifyIdToken` helper using `jose.jwtVerify` against the provider's JWKS endpoint, plus nonce echo from the framework-signed state. Mark it `@internal` until needed. Document the gating: any future code path that promotes id_token claims to identity decisions must route through this helper.
- **Verification:** Test the helper directly: a Google-signed id_token with the right nonce verifies; a token with a different nonce fails; an expired token fails; an unsigned token fails.
- **Resolved:** `197aa4d` — new `modules/oauth/verifyIdToken.ts` exports `verifyIdToken({ idToken, key, expectedNonce, expectedIssuer, expectedAudience })`. `key` accepts either a JWKS URI (production, memoized per-URL) or a pre-built JWKSet/CryptoKey (tests). Constant-time nonce compare. Throws `AuthenticationError` on every failure. Marked `@internal` — no adapter consumes it yet; lock-in for any future id_token identity-decision path. 10 tests covering signature, nonce, issuer, audience, expiry, JWKS no-match, missing inputs, and per-URI memoization.

### F14. RedisCache uses `msgpackr` without integrity check

- **File:** `packages/core/src/app/services/cache/RedisCache.ts:51,70,79-86`
- **Severity:** **Medium**
- **Exploitability:** Compromised Redis tier (shared multi-tenant Redis, misconfigured ACL, leaked password, or a co-located service with Redis access) lets an attacker inject crafted msgpackr payloads. `msgpackr` is more strict than `pickle`/`json` re: deserialization, but the library is not designed to defend against untrusted input; an attacker can construct payloads that trigger unexpected object shapes, leading to logic errors at the call site (e.g., a "session object" with admin-equivalent flags).
- **Impact:** Privilege escalation via cache poisoning. Acute under shared Redis tiers.
- **Suggested fix:** Add optional HMAC signing (env-driven `CACHE_SIGNING_KEY`) on `set`, verify on `get`; reject mismatched signatures by deleting the key and returning `null`. Make it opt-in initially with a security doc note explaining the threat model that triggers the feature (shared Redis, untrusted clustermates).
- **Verification:** Test: with signing enabled, `set("k", v)` then `get("k")` round-trips. Test: with signing enabled, manually overwrite the raw Redis value with a different msgpackr buffer; `get("k")` returns `null` and removes the poisoned entry. Test: signing disabled → unchanged behavior.
- **Resolved:** `39e5afd` — `RedisCacheOptions.signingKey?: string` (≥ 32 chars). Frame: `[0x01][HMAC-SHA256(namespacedKey || msgpackrBytes)][msgpackrBytes]`. `get()` returns `null` + fire-and-forget `del` on any mismatch. MAC binds value to key (replay-under-different-key fails). Disabled by default. `.cursor/rules/security.mdc` gains a "Cache (Redis)" section. 7 new tests cover round-trip, frame structure, mismatch + delete, legacy-unsigned-under-signing, value/key binding, disabled default, ≥32-char guard.

### F15. Streaming SSE / `streamLLM` has no per-event size cap

- **File:** `packages/core/src/http/streaming/streamLLM.ts:126-141`
- **Severity:** **Medium**
- **Exploitability:** A buggy or malicious LLM provider emits multi-MB single events (e.g., a tool-call argument that's been duplicated). The framework writes the event verbatim; the consumer's bandwidth and the client's memory both pay. Under public traffic, a single bad upstream amplifies into a DoS surface.
- **Impact:** DoS amplification and bandwidth bill spike.
- **Suggested fix:** Add a `maxEventBytes` option to `streamSSE` and `streamLLM` (default 256 KB). Skip events over the cap; log a warning with `provider`, `eventSize`, and a sampled tail of the event for diagnosis. Emit an OTel counter `stream.event.dropped_oversized` so operators can monitor.
- **Verification:** Test: a synthetic provider emits a 1 MB event; the SSE stream skips it and logs the warning. Test: events under the cap pass through unchanged.
- **Resolved:** `650378d` — `StreamLLMOptions.maxEventBytes` (default 256 KB) + `provider` tag. OTel counter `stream.event.dropped_oversized` increments per drop (meter `ship-api.streaming`). Warn line includes `eventType`, `eventBytes`, `maxEventBytes`, last-256-char `sampleTail`. 4 new tests in `streamLLM.test.ts`.

### F16. OAuth state replay within signature window

- **File:** `modules/oauth/state.ts` · `modules/oauth/routes.ts:212-220`
- **Severity:** **Medium**
- **Exploitability:** Framework-signed state is single-use *only* because the upstream provider invalidates the auth code on exchange. If a provider's invalidation is delayed (some providers retry on idempotent failure) or if a downstream adapter retries the exchange, the framework's verifier doesn't notice the replay. Belt-and-braces defense.
- **Impact:** Theoretical; depends on provider misbehavior.
- **Suggested fix:** Persist used state JTIs in a short-TTL cache (60 seconds covers any reasonable round trip; the state's own 10-minute expiry handles older replays). On callback, reject if the JTI has already been seen.
- **Verification:** Test: a successful callback flow; immediately re-submit the same state — second submit returns 400.
- **Resolved:** `c8ca386` — new `modules/oauth/stateJtiCache.ts` defines `StateJtiCache` interface + `InMemoryStateJtiCache` (`seenAndRecord(jti, ttlMs=60_000)`). `verifyState` now surfaces the auto-generated nonce as a JTI. Callback handler in `routes.ts` rejects the second use with `BadRequestError`. Optional `OAuthRoutesDeps.stateJtiCache` for multi-instance deployments. 6 unit tests + 1 E2E replay test + 2 existing state tests updated for the nonce surfacing.

### F17. CLI `create.js` project name not validated for path traversal

- **File:** `packages/core/cli/commands/create.js:10-12`
- **Severity:** **Medium**
- **Exploitability:** Local-only impact — the user runs the CLI on their own machine — but `projectName=../../../etc/foo` resolves outside `cwd` and `copyTemplate` writes there. Worst case is filesystem clobbering of paths the user owns; not an RCE, but a footgun.
- **Impact:** Local filesystem clobbering.
- **Suggested fix:** Regex-validate `/^[a-z][a-z0-9-_]*$/i` before `path.resolve`. Reject names containing `/`, `\`, `..`, or null bytes. Output a helpful error pointing at the npm-compatible naming rules.
- **Verification:** Test: `ship-api create ../etc/foo` exits with non-zero status and a clear error. Test: `ship-api create my-app` succeeds.
- **Resolved:** `8181616` — `validateProjectName()` exported from `create.js` runs before any filesystem touch. Rejects `..`, `/`, `\`, `\0`; enforces `/^[a-z][a-z0-9_-]*$/i` (npm-package-name rules). 10 new unit tests in `create.test.js`.

### F18. Webhook JSON-parse failure surfaces as 500 instead of 400

- **File:** `packages/core/src/http/utils/webhooks.ts:188-195`
- **Severity:** **Low** (recalibrated from Agent 2's High)
- **Exploitability:** Theoretical 500-vs-401 status-code oracle: 401 (signature failed) vs 500 (signature passed, body invalid). To exploit, an attacker needs to brute-force the *signature output* (256-bit HMAC-SHA256), not the secret. ~2^256 attempts; impractical.
- **Impact:** Status-code hygiene; no practical leak.
- **Suggested fix:** Wrap the parse step in try/catch and throw `BadRequestError("Webhook payload is not valid JSON")`. Returns 400, not 500.
- **Verification:** Test: a request with a valid signature but invalid JSON body returns 400 with a clear error message.
- **Resolved:** `9bf1286` — try/catch around `JSON.parse(rawBody)` in `parseWebhook`; throws `BadRequestError("Webhook payload is not valid JSON: …")` on SyntaxError. Signature verification still runs first (no oracle). 3 new tests cover valid-HMAC+invalid-JSON → 400, invalid-HMAC+invalid-JSON → 401 regression, valid-HMAC+valid-JSON → 200 regression.

### F19. Idempotency `setIfAbsent` atomicity is an undocumented invariant

- **File:** `packages/core/src/app/services/cache/InMemoryCache.ts:51-65` · `packages/core/src/http/middleware/idempotency.ts:180`
- **Severity:** **Informational** (recalibrated; current impl is correct)
- **Exploitability:** Current implementation is atomic — `setIfAbsent` body runs synchronously inside the async function (no `await` between `has` and `set`), so within a single event-loop tick the operation is a true CAS. RedisCache uses `SET … NX EX` which is atomic at Redis. No bug today. **Risk:** a future refactor adding an `await` between `has` and `set` silently breaks idempotency under concurrent load on a public app.
- **Impact:** No current attack surface; defends against future regression.
- **Suggested fix:** Add a doc comment to the `Cache` interface declaring `setIfAbsent` as an atomic operation. Add a regression test asserting that 100 concurrent `setIfAbsent` calls return `true` for exactly one caller.
- **Verification:** The regression test described above.
- **Resolved:** `9df0dbc` — atomicity-invariant JSDoc paragraph added to the `Cache.setIfAbsent` interface declaration. New 100-concurrent-CAS regression test in `InMemoryCache.test.ts` asserts exactly one `true` + that the persisted value matches the winner. No behavior change.

### F20. Upload `allowUndetectedMime` permissive semantics

- **File:** `packages/core/src/http/utils/uploads.ts:107-117`
- **Severity:** **Medium**
- **Exploitability:** When `allowUndetectedMime: true` is set alongside a `mimeTypes` allowlist, the semantics are: bypass the allowlist for files whose magic bytes don't match a known type. Consumers might read this as "accept undetected files but still validate detectable ones" (defensive) vs the actual behavior (permissive). Public app + permissive upload = malware/SVG-XSS staging via files that look like text-but-aren't.
- **Impact:** Bypass of file-type defense; not an immediate vulnerability but a footgun for adopters.
- **Suggested fix:** Rename to `skipMimeValidationForUndetected` (explicit). Default-deny: add a `requireDetectableMime: true` option that rejects files whose magic bytes can't be classified. Document both behaviors. Deprecate `allowUndetectedMime` for one minor cycle before removing.
- **Verification:** Test: a file with no detectable magic bytes is rejected under default settings. Test: with `skipMimeValidationForUndetected: true`, the file passes. Test: deprecation warning fires when `allowUndetectedMime` is set.
- **Resolved:** `1e7b69f` — `FileSchemaOptions` gains `skipMimeValidationForUndetected` (explicit rename) and `requireDetectableMime` (default-deny escalation that fires even without `mimeTypes`). `allowUndetectedMime` is `@deprecated`, still works for one cycle, emits a one-time `console.warn` pointing at the rename. 5 new tests cover the rename, default-deny, back-compat, and one-time-warning contracts.

---

## P2 — polish (ship as cycles allow)

### F21. Bearer / WS subprotocol case-handling edge case

- **File:** `packages/core/src/app/auth/adapters/firebase.ts:82-96` · `packages/core/src/http/ws/auth.ts:73-76`
- **Severity:** Low
- **Exploitability:** Case-insensitive prefix check followed by case-sensitive `slice(BEARER_PREFIX.length)` assumes the prefix is exactly `BEARER_PREFIX.length` characters. With `"Bearer.token"` (capital B in the WS path), the check passes but the slice may misalign by an unrelated index.
- **Fix:** Normalize to lowercase before slicing, or use `slice` based on the matched prefix length.
- **Verification:** Test with mixed-case Bearer prefixes.
- **Resolved:** `a26c7fd` — defensive comment in `extractWsAuth` documenting why the slice is safe given the ASCII-length-equivalent prefix. 3 new regression tests pin the invariant (`Bearer.<token>` TitleCase, `BeArEr.<token>` mixed, token-case preservation). firebase adapter already uses regex `.replace()` — no change needed.

### F22. API-key timing-compare dummy uses presented length

- **File:** `packages/core/src/http/middleware/apiKey.ts:34-46`
- **Severity:** Low
- **Exploitability:** Mismatch-path dummy `timingSafeEqual(aBuf, aBuf)` uses the presented buffer's length, which could leak the *presented* length via total execution time (not the secret's length).
- **Fix:** Use the *expected* secret's length for the dummy compare. Marginal improvement.
- **Verification:** Microbench timing across mismatched-length inputs.
- **Resolved:** `5e1fd93` — `safeCompare(expected, presented)` reordered so the mismatch-path dummy operates over the expected buffer (server-side secret), not the attacker-controlled presented value. Doc comment explains the contract. 7 existing apiKey tests continue to pass.

### F23. OAuth callback error params not length-bounded

- **File:** `modules/oauth/routes.ts:197-204`
- **Severity:** Low
- **Exploitability:** Provider-supplied `error` and `error_description` strings round-trip into the redirect URL with `URLSearchParams` encoding. A pathologically long error overflows URLs; not exploitable but ugly.
- **Fix:** Truncate to 256 chars defensively.
- **Verification:** Test with a 10 KB synthetic error string.
- **Resolved:** `5350477` — `q.error.slice(0, 256)` + same for `error_description` before URL round-trip in the provider-error short-circuit. 1 new test confirms 2000-char inputs are bounded to 256 chars.

### F24. CSRF Origin-header well-formedness check

- **File:** `packages/core/src/http/middleware/csrf.ts:66-77`
- **Severity:** Low
- **Exploitability:** `allowed.has(origin)` correctly fails for malformed values like `javascript:alert()`, but no positive validation. Defense in depth.
- **Fix:** Add `new URL(origin)` parse + reject malformed; normalize to lowercase before set membership check.
- **Verification:** Test with malformed Origin headers.
- **Resolved:** `2c1063f` — `originFromHeaders` parses both `Origin` and `Referer` via `new URL(...)`, rejects non-http(s) schemes, and returns lowercased origin. Allowlist lowercased at construction. 3 new tests (malformed Origin, case-insensitive match, non-http(s) reject).

### F25. CSRF double-submit cookie length not validated on compare

- **File:** `packages/core/src/http/middleware/csrf.ts` (around `safeEqual`)
- **Severity:** Low
- **Exploitability:** Empty cookie + empty header could short-circuit constant-time compare; truncated cookie matching truncated header is unlikely but possible.
- **Fix:** Validate length matches the expected 32-char base64url-encoded value before compare.
- **Verification:** Test with empty / truncated cookies.
- **Resolved:** `2c1063f` — `TOKEN_LENGTH = 32` constant; double-submit verifier rejects wrong-length values before `safeEqual`. Defends against empty cookie + empty header short-circuit and truncated-cookie / truncated-header pairing. 2 new tests. 3 existing tests updated to use 32-char tokens.

### F26. Predictable rate-limit `entryId` counter

- **File:** `packages/core/src/app/services/rateLimit/RedisSlidingWindowBackend.ts:73-79`
- **Severity:** Low
- **Exploitability:** `entryCounter` is a per-process monotonic counter seeded at module load; an attacker timing multiple requests can predict the next counter value. Low-impact info leak (allows inferring server uptime or restart events).
- **Fix:** Switch the suffix to `crypto.randomBytes(8).toString("hex")`.
- **Verification:** Test that two consecutive `nextEntryId()` calls produce non-adjacent random suffixes.
- **Resolved:** `9f126e7` — `nextEntryId` now uses `randomBytes(8).toString("hex")` for 64 bits of entropy per entry, preserving the `${now}-${random}` time-ordering shape. Existing 7 rate-limit tests continue to pass.

### F27. CSRF `httpOnly: false` is by design; production-ops doc is missing

- **File:** `packages/core/src/http/middleware/csrf.ts:113`
- **Severity:** Informational
- **Notes:** The double-submit cookie is intentionally readable by JS so the client can echo it into the header. This means XSS = CSRF bypass; the framework's CSRF defense is defense-in-depth on top of CSP-defended XSS, not a standalone bulwark.
- **Fix:** Add a doc block in `csrf.ts` explaining the threat model, and recommend a CSP profile in the security docs. Add a "header-only mode" option for consumers whose XSS posture is uncertain.
- **Resolved:** `98de88d` — `doubleSubmit` JSDoc spells out the XSS-bypass property + recommends CSP / SRI / Trusted Types. New `headerOnly?: boolean` option skips cookie issuance under double-submit. 2 new tests.

### F28. Rate-limit `onBackendError: 'allow'` is a deployment footgun

- **File:** `packages/core/src/http/middleware/rateLimit.ts:114,136`
- **Severity:** Informational
- **Notes:** Default is `'deny'` (fail-closed; correct). The `'allow'` option is documented but the failure-mode consequences could be louder.
- **Fix:** Add a security note in the JSDoc that `'allow'` removes rate limiting when Redis is unavailable; if Redis flapping is common in the consumer's infra, fix Redis first rather than picking `'allow'`.
- **Resolved:** `acf4574` — JSDoc on `RateLimitOptions.onBackendError` now spells out the "removes rate limiting entirely" consequence + names the endpoint classes most affected + gives concrete defensible-vs-wrong deployment examples. No code behavior change; default is still `'deny'` (fail-closed).

---

## Roadmap-level findings (deferred but surfaced for adopter awareness)

These are not v4.0 fixes; they're context for the G2 reviewer and for adopters to plan around.

### R1. No first-class multi-tenancy primitives

Tracked as `V8` in `docs/V4_STATUS.md`. **Update (post-audit): A2-1 (`c54f7d1`) shipped the opt-in tenancy *model*** — `tenantScoped()` column mixin, `resolveTenant()` middleware, and `RequestContext.tenantId` (all barrel-exported) — so the convention now exists; **enforcement (RLS / auto-scoping) remains deferred to V8.** As first audited (2026-05-10), the framework had no `tenantId` convention, no AsyncLocalStorage tenant helper, no row-level-security generators, and no `tenantId` audit column in `baseFields`. With A2-1, consumers have the column shape + resolution convention but must still enforce isolation themselves until V8 — see `SECURITY_REVIEW_BRIEF.md` surface #4 (the G2 reviewer should assess this model).

Specific framework defaults that compound this absence (each is its own finding above):

- **F10**: idempotency `scope` defaults to `"global"` — no tenant prefix
- Permission slugs (`module:resource:action`) have no tenant prefix in the default schema
- `RedisCache` namespace (`keyPrefix`) is per-service, not per-tenant — consumers must layer
- Signed-URL keys (`storage.signedUrl(key, ...)`) trust the caller's key shape — no built-in tenant-prefix enforcement

The audit doc lists these to inform G2's recalibration when the multi-tenancy primitives ship in v4.x.

### R2. No outbound webhook signing primitives

Tracked as `V4` in `V4_STATUS.md`. Public-facing apps that fire outbound webhooks reinvent HMAC signing + retry + replay-protection. Watchlist; ships in v4.x with BullMQ-backed retry. Until then, consumers should mirror the `parseWebhook` HMAC pattern in their own outbound code.

---

## Verified strengths (enumerated for G2 reviewer calibration)

These defenses are **in place and verified**:

1. **Constant-time API-key compare** — `packages/core/src/http/middleware/apiKey.ts:34-46` uses `crypto.timingSafeEqual` with a buffer-equalization dummy on mismatch (F22 notes a marginal hardening; the core defense is sound).
2. **Constant-time webhook signature compare** — `packages/core/src/http/utils/webhooks.ts:42-50`. Same pattern across all built-in verifiers (Stripe, GitHub, Slack).
3. **Constant-time CSRF token compare** — `packages/core/src/http/middleware/csrf.ts:83-91`.
4. **Refresh token hash-only storage** — `packages/core/src/app/auth/jwt/RefreshTokenStore.ts`. DB breach yields hashes, not usable tokens. Tokens are SHA-256(raw) before write; raw never persisted.
5. **Refresh token rotation with chain revocation** — `packages/core/src/app/auth/jwt/DrizzleRefreshTokenStore.ts:147-175`. Recursive CTE walks `replacedById` chain; reuse detection burns the entire chain.
6. **256-bit refresh token entropy** — `packages/core/src/app/auth/jwt/RefreshTokenStore.ts:93-95` uses `randomBytes(32).toString("base64url")`.
7. **JWT ES256 hardcode** — `packages/core/src/app/auth/jwt/JwtSigner.ts:104,175`. Defends against algorithm-confusion attacks (HS256 downgrade).
8. **JWT `kid`-based key rotation** — `JwtSigner.ts:113-133`. Zero-downtime rotation: head signs, all entries verify.
9. **OAuth state signing with rotation set** — `modules/oauth/state.ts`. `StateSecret = string | readonly string[]`; head signs new state, every entry accepted on verify; constant-iteration verify loop avoids leaking which key matched.
10. **`requireAuth` rejects present-but-invalid tokens even in optional mode** — `packages/core/src/http/middleware/requireAuth.ts:92-100`. No "fall through silently" path for forgeries.
11. **`.strict()` on object validation schemas** — `modules/*/validation/schemas.ts`. Defends against mass-assignment: unknown keys produce 400.
12. **Pino redactor covers auth-relevant headers** — `packages/core/src/observability/logger.ts:31-56`. `Authorization`, `Cookie`, `password`, `token`, `secret`, `apiKey`, Firebase/GCP credentials. Extensible via `extraRedactPaths`.
13. **`audit-ci` hard-fails high/critical** — `.audit-ci.json`. Prevents silent accumulation of known npm vulns.
14. **MCP server is stdio-only** — `packages/mcp-server/src/server.ts:1-4`. No HTTP socket; only callable by the local Claude/Cursor process (F7 is the dev-vs-prod targeting concern, not network exposure).
15. **Auth cookies are httpOnly + secure-in-prod + sameSite=Lax + path-scoped** — `packages/core/src/http/utils/authCookies.ts:83-99`. Refresh cookie scoped to `/auth/refresh` for blast-radius mitigation (F5 is the `domain` option footgun).
16. **Rate limiter fails closed by default** — `packages/core/src/http/middleware/rateLimit.ts:114,136`. Redis-down → 429 (not unlimited access).
17. **DiskStorage three-layer path-traversal check** — `packages/core/src/app/services/storage/DiskStorageAdapter.ts:54-67`. Normalize → reject `..` → post-resolve `startsWith(rootDir + sep)` (F6 is the symlink gap; the string-based defense itself is sound).
18. **Webhook raw-body read before parse** — `packages/core/src/http/utils/webhooks.ts:182-195`. Preserves the exact bytes the sender signed.
19. **Idempotency persists `AppError` responses** — `packages/core/src/http/middleware/idempotency.ts:206-209`. Failures are idempotent; retries get the same error, not a fresh attempt.
20. **ESLint `no-restricted-syntax` blocks raw `c.req.json/query/param`** — `eslint.config.mjs`. Forces all input through Zod schemas.
21. **`migrate-orm` CLI is pure AST/regex — does NOT `eval` scanned code** — `packages/core/cli/commands/migrate-orm.js:163-169`. Verified safe codegen path.
22. **`RedisCache` key namespacing via `keyPrefix`** — `packages/core/src/app/services/cache/RedisCache.ts:40-65`. Prevents cross-service cache poisoning (F14 is the integrity-check gap, orthogonal to namespacing).

---

## Watchlist (worth closer human review; not yet concrete findings)

- **Firebase `checkRevoked: false` default** — `packages/core/src/app/auth/adapters/firebase.ts:54`. Performance optimization (saves a Firebase Admin RPC per request). For sensitive operations (admin actions, billing changes, account deletion), consumers should opt into `checkRevoked: true`. Document this loudly.
- **OAuth callback intentionally lacks `requireAuth`** — `modules/oauth/routes.ts:187`. Correct for unauthenticated OAuth initiation, but the state signature is the only binding between the issuing account and the callback's `accountId`. Add a doc box for consumers explaining this.
- **Recursive CTE on `revokeChain`** — `packages/core/src/app/auth/jwt/DrizzleRefreshTokenStore.ts:147-175`. Stack-depth limits on pathologically long token chains. Token TTLs bound this in practice, but worth knowing.
- **BullMQ job payload deserialization** — `packages/core/src/app/services/jobs/`. Out-of-scope for this first pass; same untrusted-Redis surface as F14 (RedisCache). If consumers use a shared Redis tier for both, the threat models overlap.
- **WebSocket auth has no failure-log hook** — `packages/core/src/http/ws/auth.ts:124-180`. Blind brute-force visibility is at the proxy layer only. Consider an optional `onAuthFailure` callback for application-layer monitoring.
- **AsyncLocalStorage request-context propagation** — verify `accountId` (and future `tenantId`, R1) can't leak across awaits to a wrong request. Run a stress test that interleaves requests with adversarial async ordering.

---

## Out of scope

- **Third-party dependencies** — `audit-ci` (hard-fail on high/critical) is the gating mechanism. `.audit-ci.json` is the source of truth.
- **Consumer business logic** — applies on top of the framework; not in this audit's scope.
- **Infrastructure** — TLS termination, k8s RBAC, secret managers beyond `defineEnv`, network policies. Adopters' responsibility.
- **G2 external review surface** — this doc is the input; G2 should extend to surfaces this internal pass didn't cover (e.g., a deep-dive on the OAuth flow with provider-specific known attacks, a structured fuzzing pass on `parseUpload` / `parseWebhook`).

---

## Remediation roadmap

| Tier | Findings | Trigger |
|---|---|---|
| **P0** | F1–F9 | Pre-G2 / pre-GA · 2 Critical + 7 High |
| **P1** | F10–F20 | Next minor (`4.0.0-alpha.3` or `-beta.0`) · multi-tenant hardening pass |
| **P2** | F21–F28 | Polish; ship as cycles allow |
| **Roadmap** | R1 (V8 multi-tenancy) · R2 (V4 outbound webhooks) | Tracked in `V4_STATUS.md` deferred list |

Each P0 fix lands with:
1. A failing regression test before the fix.
2. The minimal change called out in "Suggested fix".
3. Re-run to green + `npm run ci` at repo root.
4. A grep pass for similar instances elsewhere.
5. A "Resolved: `<commit-sha>`" annotation under the finding here.

`docs/V4_STATUS.md` tracks P0 closure as sub-bullets under the G2 GA-blocker entry.
