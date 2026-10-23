# First-party credential auth

> **Kernel feature.** `@sixthsummit/ship-auth-credentials` composes password
> accounts, email verification, TOTP MFA with recovery codes, sessions with
> revocation, lockout and an auth audit log as declared operations plus an
> actor provider beside the Firebase resolver ([ADR-0025](../../rearchitecture/decisions/0025-first-party-credential-auth.md)).
> It has no compatibility-line counterpart; the compat `AuthFlow` stays as it is.

| Package | Owns |
| --- | --- |
| `@sixthsummit/ship-auth-credentials` | `defineCredentialAuthModule`, `defineCredentialAuthMailer`, `credentialAuthentication` (adapter + resolver), `credentialAuthRateLimitPolicies`, the `CredentialStore` contract and in-memory store, crypto (`scryptPasswordHasher`, TOTP, tokens, `createSecretBox`), policies |
| `…/drizzle` | `shipAuthTables()` and `createDrizzleCredentialStore()` |
| `…/console` | `credentialAuthConsoleExtension()` for `defineConsoleModule({ extensions })` |
| `…/conformance` | `credentialStoreConformance` |
| `@sixthsummit/ship-angular/credential-auth` | `provideShipCredentialAuth`, `ShipCredentialAuth`, `ShipSignInComponent`, `ShipMfaChallengeComponent`, `ShipRecoveryCodeComponent`, `ShipAuthAuditPanelComponent`, `ShipCredentialAuthContract` |

## 1. Tables and store

```ts
// src/schema.ts
import { shipAuthTables } from "@sixthsummit/ship-auth-credentials/drizzle";
export const { authAccounts, authCredentials, authTokens, authMfaSecrets, authRecoveryCodes, authSessions, authAuditEvents } = shipAuthTables();
```

Generate the migration with `drizzle-kit generate` and apply it through the
gated release step ([schema safety](./schema-safety.md)); the tables are only
ever added to. Bind the store:

```ts
const store = createDrizzleCredentialStore({ database, tables: authTables });
```

`createInMemoryCredentialStore()` serves tests; run `credentialStoreConformance`
against any other implementation.

## 2. Mailer, module and policies

```ts
const mailer = defineCredentialAuthMailer({ from: "App <auth@example.com>", appName: "App" });
const delivery = defineMailDelivery({ mailers: [mailer, ...others] }); // one mail.deliver job

export const auth = defineCredentialAuthModule({
  store,
  mailer,
  mail: delivery.dependency,
  links: {
    verifyEmail: (token) => `${env.APP_URL}/verify/${token}`,
    resetPassword: (token) => `${env.APP_URL}/reset/${token}`,
    signIn: `${env.APP_URL}/sign-in`, // the existing-account notice links here
    changeEmail: (token) => `${env.APP_URL}/email/${token}`,
  },
  secrets: { current: "k1", keys: { k1: env.AUTH_MFA_KEY } },
  policies: {
    password: { minLength: 12, maxLength: 256 },
    lockout: { threshold: 5, windowMs: 15 * 60_000, durationMs: 15 * 60_000 },
    session: { maxAgeMs: 30 * 24 * 60 * 60_000, idleTimeoutMs: 12 * 60 * 60_000 },
    mfa: { required: (account) => account.roles.includes("admin") },
    tokens: { verifyEmailTtlMs: 24 * 60 * 60_000, resetPasswordTtlMs: 60 * 60_000 },
    requireVerifiedEmail: true,
    onExistingEmail: "conceal", // default; "reject" answers 409 and enumerates accounts
  },
  defaultRoles: ["member"],
  clients, // createRequestClientRegistry(), shared with the adapter
});
```

The module declares `auth.mailer`, provides and exports the store token, and
imports the modules that export the job backend behind the sender (`imports`,
default `["mail"]`; the customized consumer passes `["portfolio"]`). Mount it like any
module; `createHonoAdapter` projects `/auth/*`.

| Operation | Transport | Access | Result |
| --- | --- | --- | --- |
| `auth.register` | `POST /auth/register` | public | 201 `{ status: "verification-sent" }`; `AUTH_EMAIL_TAKEN` 409, `AUTH_PASSWORD_POLICY` 422 |
| `auth.verify-email` | `POST /auth/verify-email` | public | 200; `AUTH_TOKEN_INVALID` 400 (unknown, expired, used) |
| `auth.resend-verification` | `POST /auth/resend-verification` | public | 202 always |
| `auth.sign-in` | `POST /auth/sign-in` | public | 200 `signed-in` \| `mfa-required` \| `mfa-enrolment-required`; `AUTH_INVALID_CREDENTIALS` 401, `AUTH_ACCOUNT_LOCKED` 423 + `Retry-After`, `AUTH_EMAIL_UNVERIFIED` 403, `AUTH_ACCOUNT_DISABLED` 403 |
| `auth.totp.verify` / `auth.recovery.consume` | `POST /auth/totp/verify`, `/auth/recovery/consume` | public | 200 `signed-in`; `AUTH_MFA_INVALID_CODE` / `AUTH_RECOVERY_CODE_INVALID` 401, `AUTH_TOKEN_INVALID` 400 |
| `auth.sign-out`, `auth.me` | `POST /auth/sign-out`, `GET /auth/me` | authenticated | current session |
| `auth.sessions.list` / `.revoke` / `.revoke-all` | `GET /auth/sessions`, `POST /auth/sessions/revoke`, `/auth/sessions/revoke-all` | authenticated | `{ keepCurrent }` on revoke-all |
| `auth.forgot-password` / `auth.reset-password` | `POST /auth/password/forgot`, `/auth/password/reset` | public | 202 always; reset clears the lock and signs every session out |
| `auth.change-email` / `auth.confirm-email-change` | `POST /auth/email/change`, `/auth/email/confirm` | authenticated / public | password re-entry; mail to the new address |
| `auth.totp.enrol` / `auth.totp.confirm` | `POST /auth/totp/enrol`, `/auth/totp/confirm` | authenticated | password re-entry; confirm returns the recovery codes once |

Every flow writes an audit row (`register`, `sign-in`, `sign-in.locked`,
`mfa.challenged`, `mfa.verify`, `mfa.recover`, `mfa.enrolled`,
`password.reset`, `email.changed`, `session.revoke`, `sessions.revoke-all`, …)
with outcome, request id, ip and user agent, never a secret.

## 3. The actor provider

```ts
const http = createHonoAdapter(app, {
  auth: credentialAuthentication({
    store,
    clients,
    session: auth.policies.session,
    resolveActor: ({ account, session }) =>
      operationActor({
        id: account.id,
        permissions: [
          ...permissionsFor(account.roles),
          // Per-surface MFA: the admin slug only for an MFA-verified session.
          ...(session.mfaState === "verified" ? [CONSOLE_OPERATE_PERMISSION] : []),
        ],
      }),
  }),
  preValidationPolicies: credentialAuthRateLimitPolicies({ max: 10, windowMs: 60_000 }),
});
```

The adapter reads `Authorization: Bearer ship_s_…`; the resolver checks the
session (unrevoked, within max age and idle timeout, created after the
account's `sessionsInvalidBefore`, account active) and yields the identity
`{ provider: "ship-credentials.session", subject: sessionId }` and the actor
from `resolveActor`. A `pending-enrolment` session reaches only the enrolment
operations, sign-out and `me`. To run beside Firebase, dispatch on the
credential kind (see the customized golden consumer's `auth.ts`).

## 4. Rate limiting

`credentialAuthRateLimitPolicies({ moduleId?, windowMs, max, operations?, key?, store? })`
returns `preValidationPolicies` (SAPI-476) for the public flows, keyed by
client ip, answered with `AUTH_RATE_LIMITED` 429 and `Retry-After`,
`RateLimit-Limit`, `RateLimit-Remaining`. The in-memory store is per process;
bind a shared `RateLimitStore` in a fleet. The lockout policy guards the
credential itself and applies to direct execution.

## 5. The console panel

```ts
defineConsoleModule({
  imports: [..., "auth"],              // the auth module exports the store token
  extensions: [credentialAuthConsoleExtension()],
});
```

`console.auth-audit.events` (`GET /console/auth-audit/events?accountId|email&event&outcome&before&limit`),
`.account` (lock state, sessions, recovery-code counts), `.revoke` (one or
all sessions), `.unlock`, `.status` (`disabled` revokes every session), all
gated by `console.operate` and audited with the operator id. In Angular, mount
`ShipAuthAuditPanelComponent` under the console shell with
`SHIP_AUTH_AUDIT_CLIENT` provided.

## 6. Angular screens

```ts
provideShipCredentialAuth({ client: () => injectShipClient(APP_CLIENT), storage: browserSessionStorage() });
// credential capability for the operation client:
{ kind: "bearer", getToken: () => injectCredentialAuth().getToken() }
```

`ShipCredentialAuth` is signal-first: `state` (`unknown` → `anonymous` /
`challenged` / `enrolment-required` / `signed-in`), `account`, `failure`
(declared failures as values, with `retryAfterSeconds` from lockouts and rate
limits), `sessions`, `recoveryCodes`. `ShipSignInComponent` emits the sign-in
result, `ShipMfaChallengeComponent` and `ShipRecoveryCodeComponent` answer
the pending challenge and emit `expired` when the challenge is gone.

## Security choices

See the table in [ADR-0025](../../rearchitecture/decisions/0025-first-party-credential-auth.md):
argon2id from `node:crypto` (scrypt available, pluggable), RFC 6238 TOTP with
replay guard, SHA-256 token hashes,
AES-256-GCM MFA secrets under a key ring, hashed single-use recovery codes,
constant-time comparisons, a decoy hash on unknown emails, opaque hashed
session bearers.

### Passwords

`argon2idPasswordHasher()` is the default: argon2id from `node:crypto`, 64 MiB,
three passes, one lane, in the standard PHC string, so hashes are portable.
Pass `hasher: scryptPasswordHasher()` to keep scrypt, or any `PasswordHasher`.
The argon2id hasher also verifies `$scrypt$` hashes and reports them through
`needsRehash`, so an installation that started on scrypt upgrades each account
on its next successful sign-in with no migration.

### Registering an email that already has an account

`onExistingEmail` defaults to `"conceal"`: `register` answers `201` exactly as
it does for a new address, and the existing address is told instead. An
unverified account receives its verification link again; a verified one
receives the `existingAccount` message with a link to `links.signIn`. The
caller cannot tell the two cases apart, so the endpoint does not enumerate
accounts, which matters once sign-in and forgot-password already conceal.
`links.signIn` is required in this mode and refused at definition time when
missing. `"reject"` answers `409 AUTH_EMAIL_TAKEN`; opt in where account
existence is not sensitive.

## Proof

- `packages/auth-credentials/src/module.test.ts`: every flow and policy edge
  (expired and replayed tokens, lockout and lockout reset, replayed TOTP step,
  replayed recovery code, revoke-all during an in-flight authorized request,
  idle and absolute session expiry, MFA required per role with the
  pending-enrolment session, rate limiting over HTTP only).
- `drizzle.integration.test.ts`: the store conformance suite and the full flow
  against real PostgreSQL.
- `console.test.ts`: the panel namespaced by the console id, refused without
  `console.operate`, read/unlock/revoke/disable with operator audit rows.
- `fixtures/consumers/customized`: the module beside the session directory
  through a composite credential adapter, `0004_credential_auth` generated from
  schema source, the `sre` role forced through TOTP enrolment before its
  session reaches the console, and the audit panel read over HTTP against
  PostgreSQL.

## Diagnostics and errors

| Code | Where | Meaning |
| --- | --- | --- |
| `SHIP_AUTH_OPTIONS_INVALID` / `SHIP_AUTH_STORE_INVALID` / `SHIP_AUTH_MAILER_INVALID` / `SHIP_AUTH_KEY_INVALID` / `SHIP_AUTH_POLICY_INVALID` | definition | `InvalidCredentialAuthDefinitionError` |
| `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_LOCKED`, `AUTH_ACCOUNT_DISABLED`, `AUTH_EMAIL_UNVERIFIED`, `AUTH_EMAIL_TAKEN`, `AUTH_TOKEN_INVALID`, `AUTH_PASSWORD_POLICY`, `AUTH_MFA_INVALID_CODE`, `AUTH_MFA_NOT_ENROLLED`, `AUTH_MFA_ALREADY_ENROLLED`, `AUTH_RECOVERY_CODE_INVALID`, `AUTH_SESSION_NOT_FOUND`, `AUTH_RATE_LIMITED`, `AUTH_MAIL_QUEUE_FULL` | operations | declared failures |
| `AUTH_AUDIT_ACCOUNT_NOT_FOUND` | console panel | no account for the id or email |
