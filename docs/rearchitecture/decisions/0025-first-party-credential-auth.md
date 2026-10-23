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
`requireVerifiedEmail` and `onExistingEmail` (`reject` or `conceal`). An
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
| Password hashing | scrypt from `node:crypto` (N=2^15, r=8, p=1, 16-byte salt, 32-byte key), PHC string carrying the parameters, `needsRehash` upgrade on sign-in; zero native dependencies. `PasswordHasher` is pluggable so argon2id can be bound where a native binding is acceptable. |
| TOTP | RFC 6238 over HMAC-SHA1, 6 digits, 30 s, ±1 step, implemented on `node:crypto` and tested against the RFC appendix vectors; the last accepted step is stored and a code at or before it is a replay. |
| Tokens | Verification, reset, change-email, MFA challenge and session tokens are 256 random bits with a kind prefix; only their SHA-256 is stored and lookups are by hash. |
| MFA secrets at rest | AES-256-GCM under a consumer-supplied key ring (`{ current, keys }`, 32-byte keys, key id recorded on the row and bound as associated data) so keys rotate by adding one and switching `current`. |
| Recovery codes | Ten 20-character codes from a 31-symbol alphabet (~99 bits), stored hashed, each consumed once. |
| Comparisons | `timingSafeEqual` for every secret; the unknown-email path verifies a decoy hash so timing does not reveal account existence; forgot-password and resend answer 202 regardless. |
| Session token | Opaque bearer, hashed at rest, absolute and idle expiry, `revokedAt`, plus the account cutoff for revoke-all and password reset. The Angular client keeps it in memory by default (`browserSessionStorage` opts into `localStorage`). |
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
- **Two-consumer rule:** Tortlink v2 is the first named consumer (its SAPI-227
  MFA and surface policies become `mfa.required` plus `resolveActor`); its
  adoption is tracked on its own migration work and does not gate this
  decision. The second consumer is the Ship reference application planned
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

### argon2id by default

Rejected only on dependency grounds: it needs a native binding the package
should not force on every consumer. The hasher is pluggable and the choice is
recorded here for review.

### A per-panel console permission for auth audit

Rejected per ADR-0024: one `console.operate` slug keeps the grant auditable;
the extension seam enforces exactly that permission.
