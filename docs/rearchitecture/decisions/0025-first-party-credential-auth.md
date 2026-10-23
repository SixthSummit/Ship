# ADR-0025: First-party credential authentication as declared operations and a kernel actor provider

- **Status:** Accepted
- **Date:** 2026-10-23
- **Scope:** `@sixthsummit/ship-auth-credentials`: password accounts, email verification, sign-in with lockout, sessions with revocation, password reset, change-email, TOTP MFA with recovery codes, the auth audit log, the actor provider beside Firebase, the ops-console panel and the Angular screens
- **Related:** [ADR-0004](./0004-credential-actor-and-access-boundary.md) · [ADR-0015](./0015-declared-jobs-and-schedules.md) · [ADR-0021](./0021-schema-safety-gates.md) · [ADR-0023](./0023-declared-transactional-mail.md) · [ADR-0024](./0024-kernel-ops-console.md)

## Context

Every consumer authenticates through Firebase and writes its own actor
resolver. The security policy Rodauth makes declarative is scattered across
consumers as bespoke code: MFA and surface access policies (SAPI-227), an
`auth_time` floor and a `sessionsInvalidBefore` cutoff (SAPI-356), deactivated
accounts keeping full API access (SAPI-284), an unauthenticated account lookup
(SAPI-179). Each is the same class of bug Rodauth closes by default. A consumer
with HIPAA-grade requirements, or one that cannot take a Firebase dependency,
has no path onto Ship at all.

The kernel already has what a first-party provider needs: the credential /
actor / access split (ADR-0004), declared mail delivered through the jobs
capability (ADR-0023), the pre-validation policy hook for rate limiting
(SAPI-476), gated migrations (ADR-0021) and the console's extension seam
(ADR-0024).

## Decision

### An alternative actor provider, not a replacement

`credentialAuthentication({ store, resolveActor })` composes a
`HonoCredentialAdapter` (`Authorization: Bearer ship_s_…` plus the client
facts) and an `ActorResolver` with the same contract the Firebase adapter
implements. The resolver verifies the session row (live, unrevoked, not past
its absolute age or idle timeout, created after the account's
`sessionsInvalidBefore` cutoff, account active), records the client facts for
audit, and hands `{ account, session, operation }` to the application's
`resolveActor`, which builds the actor exactly as it does for Firebase. The
identity is the session (`ship-credentials.session` / session id); the actor
id is the account id. An application composes both providers side by side by
dispatching on the credential kind, as the customized golden consumer does.

### Flows are declared operations on one module

`defineCredentialAuthModule({ store, mailer, mail, links, secrets, policies })`
composes register, verify-email, resend-verification, sign-in, sign-out, me,
sessions (list, revoke, revoke-all), forgot/reset password, change-email and
confirm, TOTP enrol/confirm/verify and recovery-code consume under `/auth/*`.
Public flows are `publicAccess()`; account flows are `authenticatedAccess()`;
password re-entry guards enrolment and change-email. Every outcome, success or
failure, writes an audit row that never carries a token, code or hash. Mail
goes through the `auth.mailer` declared on the module and the application's
one `mail.deliver` job, with `verify:<account>:<token>`-style idempotency
keys. Rate limiting is `credentialAuthRateLimitPolicies()`, a set of
pre-validation policies keyed by client ip answered with the declared
`AUTH_RATE_LIMITED` failure and `RateLimit-*` headers; the account lockout is
the credential-level guard and applies to direct execution too.

### Policies are configuration

`password` (min/max length), `lockout` (threshold, window, duration, with the
counter reset once a lock lapses), `session` (absolute max age, idle timeout,
touch interval), `mfa.required` (`"never"`, `"always"` or a function of the
account, so "required per role" is one line), token TTLs, recovery-code count,
`requireVerifiedEmail` and `onExistingEmail` (`conceal` by default, or
`reject`). An
account that must enrol receives a `pending-enrolment` session that reaches
only the enrolment flow, sign-out and `me`. Per-surface MFA is expressed in
`resolveActor` from `session.mfaState` (the customized consumer grants
`console.operate` only to a verified session), so no second policy engine is
needed and the actor contract stays the one every operation already checks.

### Tables are owned by the package through the gated migration path

`shipAuthTables()` (`@sixthsummit/ship-auth-credentials/drizzle`) returns the
seven tables (`ship_auth_accounts`, `_credentials`, `_tokens`, `_mfa_secrets`,
`_recovery_codes`, `_sessions`, `_audit_events`); the application spreads them
into its schema and generates the migration with `drizzle-kit`, applied by
the ADR-0021 release step and never at boot. `createDrizzleCredentialStore`
implements the `CredentialStore` contract: every once-only transition
(consuming a token, a recovery code or a TOTP step; revoking a session) is one
conditional `UPDATE … RETURNING`, so two requests holding the same secret
cannot both win. The in-memory store implements the same contract, and
`credentialStoreConformance` (`./conformance`) proves both.

### Security choices

| Concern | Choice |
| --- | --- |
| Password hashing | argon2id from `node:crypto` (64 MiB, t=3, p=1, 16-byte salt, 32-byte tag; Node 24 ships argon2 natively, so no binding is needed), standard PHC string, `needsRehash` upgrade on sign-in. The same hasher verifies a `$scrypt$` string and reports it for rehash, so scrypt installations upgrade without a migration. `scryptPasswordHasher` stays available and `PasswordHasher` is pluggable so another implementation can be bound where binding is acceptable. |
| TOTP | RFC 6238 over HMAC-SHA1, 6 digits, 30 s, ±1 step, implemented on `node:crypto` and tested against the RFC appendix vectors; the last accepted step is stored and a code at or before it is a replay. |
| Tokens | Verification, reset, change-email, MFA challenge and session tokens are 256 random bits with a kind prefix; only their SHA-256 is stored and lookups are by hash. |
| MFA secrets at rest | AES-256-GCM under a consumer-supplied key ring (`{ current, keys }`, 32-byte keys, key id recorded on the row and bound as associated data) so keys rotate by adding one and switching `current`. |
| Recovery codes | Ten 20-character codes from a 31-symbol alphabet (~99 bits), stored hashed, each consumed once. |
| Comparisons | `timingSafeEqual` for every secret; the unknown-email path verifies a decoy hash so timing does not reveal account existence; forgot-password and resend answer 202 regardless. |
| Session token | Opaque, hashed at rest, absolute and idle expiry, `revokedAt`, plus the account cutoff for revoke-all and password reset. Carried as a bearer (native and machine clients) or, per the 2026-10-23 addendum, as an `httpOnly` cookie with CSRF protection, which is the browser default; the Angular bearer storages (`memorySessionStorage`, `browserSessionStorage`) stay for non-browser hosts. |
| Logging | Nothing secret is ever audited or logged; audit rows carry reason codes and counts only. |

### The audit log is a console panel

`credentialAuthConsoleExtension()` (`./console`) lands through the ADR-0024
extension seam: `console.auth-audit.events`, `.account`, `.revoke`, `.unlock`
and `.status`, namespaced by the console id and gated by exactly
`console.operate`. Operator actions are themselves audited with the operator
id. `@sixthsummit/ship-angular/credential-auth` ships the sign-in, MFA
challenge and recovery-code screens, the signal-first `ShipCredentialAuth`
service with a `BearerCredentialCapability`-shaped `getToken`, and the
auth-audit panel component for the console.

## Consequences

- A Firebase-free or HIPAA-shaped consumer has a path onto Ship; an existing
  consumer sees no new table, operation or dependency until it composes the
  module (default-off).
- The SAPI-227/356/284/179 bug class becomes configuration: lockout, MFA per
  role, the sessions cutoff, disabled accounts losing every session, and no
  unauthenticated account lookup.
- Mail, rate limiting, migrations and the console reuse their capabilities;
  the package adds no queue, no middleware and no second permission model.
- **Two-consumer rule:** the first named consumer is an existing
  Firebase-backed product whose MFA and surface policies (SAPI-227) become
  `mfa.required` plus `resolveActor`; its adoption is tracked on its own
  migration work and does not gate this decision. The second consumer is the Ship reference application planned
  for after the M12 batteries land, which installs the published packages
  and exercises every battery together. Until it runs, the customized golden
  consumer is the in-repo proof and the package publishes as `0.x`.
- Direct executor runs bypass the HTTP rate limit by design; the lockout and
  the audit log still apply to them.

## Rejected alternatives

### Extending the compatibility `AuthFlow` / `RefreshTokenStore`

Rejected because those are JWT-and-middleware shaped and cannot protect direct
execution; the kernel path needs operations and an actor resolver.

### JWT access tokens with refresh rotation

Rejected for this iteration: opaque sessions give immediate revocation and a
listable session table with one lookup per request, which is what the
revoke-all and console requirements need. A JWT profile can be layered later
for stateless edges.

### Storing MFA secrets in the clear or hashing them

Rejected: TOTP verification needs the secret, so hashing is impossible, and a
database read must not yield working second factors.

### scrypt by default

Shipped first on dependency grounds, then replaced: `node:crypto` on the Node
versions Ship pins exposes `argon2`, so the OWASP first-choice algorithm costs
no binding. scrypt stays selectable and verifies through the argon2id hasher so
the switch needs no migration.

### Rejecting a duplicate registration by default

Rejected: with sign-in and forgot-password already concealing account
existence, a 409 on register was the one remaining enumeration oracle, and the
consumers this package exists for (health, legal, finance) treat account
existence as sensitive. Conceal answers 201 and mails the owner instead, which
costs the registrant one confusing moment and nothing else. `reject` is one
policy line for applications that prefer the friendlier answer.

### A per-panel console permission for auth audit

Rejected per ADR-0024: one `console.operate` slug keeps the grant auditable;
the extension seam enforces exactly that permission.

## Addendum 2026-10-23: cookie-mode sessions as the browser default (SAPI-762)

This addendum adds a second session transport to the accepted decision. The
operations, the actor contract, the store and the audit log are unchanged.

### Context

The bearer session shipped first because it is transport-neutral and lets
native and machine clients hold the token themselves. In a browser the Angular
client had to keep it in memory, the only default that is not a known
vulnerability, and so signed the person out on every full reload; the opt-in
`localStorage` storage fixed reloads and handed the token to any injected
script. The industry answer for a browser is a session cookie JavaScript
cannot read, paired with CSRF protection.

### Decision

`defineCredentialAuthModule({ sessions: { transport, cookie, environment } })`
selects `bearer` (still the default, nothing changes for an existing
consumer), `cookie`, or `both`, where each sign-in chooses through a
`transport` body field that only accepts the enabled values. A cookie session
is installed by the sign-in, TOTP verify and recovery consume operations
through `respond()` headers as `httpOnly`, `Secure`, `SameSite=Lax` (or
`Strict`), `Path=/`, with `Max-Age` set to the absolute lifetime (idle expiry
stays with the resolver), and the body carries `session.transport: "cookie"`
without a token. Sign-out, revoking the current session and revoke-all clear
it. TOTP confirmation rotates a cookie session (old token revoked as
`rotated`, a verified one installed) so a cookie captured before enrolment
never carries the verified state; a bearer session is marked verified in
place so native clients keep their token. `Secure` is refused at definition
time unless `sessions.environment` is explicitly `"development"`; the package
never reads `NODE_ENV`. Cookie transports require the shared client registry,
which now records how each request authenticated.

The Hono credential adapter reads the cookie when no bearer header is
present; a bearer always wins. A cookie session the resolver cannot verify
counts as absent on a public operation and is refused on an authenticated
one: the cookie is ambient, the browser keeps sending it after a revoke-all,
and sign-in must stay reachable to replace it. A present invalid bearer keeps
the ADR-0004 rule and is refused everywhere.

CSRF protection is `credentialSessionCsrfPolicy()`, a SAPI-476 pre-validation
policy registered under the new `"*"` key of `createHonoAdapter({ preValidationPolicies })`
so it runs on every operation after actor resolution; `ship-hono` also gains
the `{ allowed: false, reason }` policy result, projected exactly as the
resolver's own 401/403, so the refusal is a declared 403 and never a 500, and
appends `Set-Cookie` instead of clobbering it. Safe methods are exempt. A
request presenting the session cookie must carry a trusted `Origin` (else the
`Referer` origin; neither is a refusal) and echo the readable CSRF cookie in
the CSRF header, compared in constant time; a session-issuing operation is
refused on an untrusted `Origin` (login CSRF) and passes without one (a native
client). Trusted origins are the consumer's list, the same as the CORS
allowlist, plus the request's own origin from the forwarded or `Host` headers.
The policy issues the CSRF cookie itself, so the token exists after the first
sign-in or `GET /auth/me`.

`@sixthsummit/ship-angular/credential-auth` makes `cookieSessionStorage()`
the default: the client asks for the cookie transport, never holds a token,
asks `me` on initialize, lets the server clear the cookie on sign-out and
adopts a rotated session. `cookieCredentialCapability()` is the
`kind: "cookie"` capability for the policy client (credentials included, the
CSRF cookie echoed in `x-csrf-token`). The bearer storages remain for native
shells and non-browser hosts.

### Consequences

- A browser app signs in, reloads and stays signed in with no token readable
  from JavaScript; the CSRF matrix and the SAPI-760 wildcard-plus-credentials
  guard close the cross-site paths; revoke-all ends a cookie session on the
  next request, including during an in-flight one.
- Cookie mode is a same-site deployment (`SameSite=Lax` never crosses sites):
  one origin behind a proxy, or sibling hosts of one registrable domain with
  `cookie.domain` set and `Access-Control-Allow-Credentials` for the exact
  app origin. The feature page records the CORS and proxy requirements.
- A consumer that enables a cookie transport must register the CSRF policy;
  the module cannot see the adapter's options, so the requirement is
  documented and proven by the customized golden consumer rather than
  enforced at construction.
- The server default stays `bearer` while the Angular default is `cookie`: a
  bearer-only module answers a cookie sign-in with a validation error naming
  `transport`, so the mismatch is explicit rather than a token the browser
  client silently discards.

### Rejected alternatives

- **Enforcing CSRF in the actor resolver.** It would need no consumer wiring
  but moves a transport concern into the credential layer and cannot issue
  the CSRF cookie; the pre-validation seam already runs after resolution with
  the request in hand.
- **Delivering the CSRF token in the sign-in body instead of a readable
  cookie.** Works across sibling hosts without `Domain`, but the token then
  lives in script state again and is lost on reload until `me` is asked; the
  double-submit cookie is the shape the compatibility `csrf()` middleware and
  the Angular interceptor already use.
- **Rotating bearer sessions on TOTP confirmation too.** Correct in principle,
  but it would sign native clients out unless they adopt the returned token;
  deferred until a native consumer asks for it.
