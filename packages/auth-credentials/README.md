# `@sixthsummit/ship-auth-credentials`

First-party credential authentication for Ship applications: password
accounts, email verification, TOTP two-factor with recovery codes, active
sessions with single and revoke-all invalidation, account lockout and an
auth audit log, composed as declared operations plus a kernel actor provider
that sits beside the Firebase resolver (same actor contract downstream).

```ts
import {
  credentialAuthRateLimitPolicies,
  credentialAuthentication,
  createRequestClientRegistry,
  defineCredentialAuthMailer,
  defineCredentialAuthModule,
} from "@sixthsummit/ship-auth-credentials";
import { createDrizzleCredentialStore, shipAuthTables } from "@sixthsummit/ship-auth-credentials/drizzle";
import { defineMailDelivery } from "@sixthsummit/ship-mail";

export const authTables = shipAuthTables();                 // include in migrations
const store = createDrizzleCredentialStore({ database, tables: authTables });
const mailer = defineCredentialAuthMailer({ from: "App <auth@example.com>", appName: "App" });
const delivery = defineMailDelivery({ mailers: [mailer, ...otherMailers] });
const clients = createRequestClientRegistry();

export const auth = defineCredentialAuthModule({
  store,
  mailer,
  mail: delivery.dependency,
  links: {
    verifyEmail: (token) => `${env.APP_URL}/verify/${token}`,
    resetPassword: (token) => `${env.APP_URL}/reset/${token}`,
    signIn: `${env.APP_URL}/sign-in`,
    changeEmail: (token) => `${env.APP_URL}/email/${token}`,
  },
  secrets: { current: "k1", keys: { k1: env.AUTH_MFA_KEY } }, // 32 bytes, hex or base64
  policies: {
    lockout: { threshold: 5, windowMs: 15 * 60_000, durationMs: 15 * 60_000 },
    session: { maxAgeMs: 30 * 24 * 60 * 60_000, idleTimeoutMs: 12 * 60 * 60_000 },
    mfa: { required: (account) => account.roles.includes("admin") },
  },
  defaultRoles: ["member"],
  clients,
});

const http = createHonoAdapter(app, {
  auth: credentialAuthentication({
    store,
    clients,
    session: auth.policies.session,
    resolveActor: ({ account, session }) =>
      operationActor({
        id: account.id,
        permissions: permissionsFor(account.roles, session.mfaState === "verified"),
      }),
  }),
  preValidationPolicies: credentialAuthRateLimitPolicies({ max: 10, windowMs: 60_000 }),
});
```

## Operations

| Operation | Transport | Access |
| --- | --- | --- |
| `auth.register`, `auth.verify-email`, `auth.resend-verification` | `POST /auth/register`, `/auth/verify-email`, `/auth/resend-verification` | public |
| `auth.sign-in` | `POST /auth/sign-in` → `signed-in` \| `mfa-required` \| `mfa-enrolment-required` | public |
| `auth.totp.verify`, `auth.recovery.consume` | `POST /auth/totp/verify`, `/auth/recovery/consume` | public (challenge token) |
| `auth.forgot-password`, `auth.reset-password` | `POST /auth/password/forgot`, `/auth/password/reset` | public |
| `auth.confirm-email-change` | `POST /auth/email/confirm` | public (token) |
| `auth.sign-out`, `auth.me`, `auth.sessions.list`, `auth.sessions.revoke`, `auth.sessions.revoke-all` | `POST /auth/sign-out`, `GET /auth/me`, `GET /auth/sessions`, `POST /auth/sessions/revoke`, `/auth/sessions/revoke-all` | authenticated |
| `auth.change-email`, `auth.totp.enrol`, `auth.totp.confirm` | `POST /auth/email/change`, `/auth/totp/enrol`, `/auth/totp/confirm` | authenticated (password re-entry) |

Sessions are opaque bearers (`Authorization: Bearer ship_s_…`), hashed at
rest. The resolver's identity is the session (`ship-credentials.session` /
session id); the actor is the account.

## Security choices

- Passwords: argon2id (`node:crypto`, 64 MiB, t=3, p=1, 16-byte salt, 32-byte tag) in the standard PHC string; `needsRehash` upgrades on sign-in, including from scrypt; `scryptPasswordHasher` and any `PasswordHasher` can be bound instead.
- Existing email on register: concealed by default (201, the owner is mailed a verification link or an existing-account notice linking to `links.signIn`); `onExistingEmail: "reject"` answers 409.
- TOTP: RFC 6238 over HMAC-SHA1, 6 digits, 30 s, ±1 step, last-used-step replay guard, tested against the RFC vectors.
- Tokens (verify, reset, change-email, MFA challenge, session): 256 random bits, only the SHA-256 is stored, consumed with a conditional write.
- MFA secrets: AES-256-GCM under a consumer key ring with key ids for rotation.
- Recovery codes: 20 characters from a 31-symbol alphabet, hashed, each consumed once.
- Every comparison of a secret is constant time; audit rows never carry tokens, codes or hashes.

See `docs/v4/features/auth-credentials.md` and ADR-0025 for the full design,
`./console` for the ops-console panel and `./conformance` for the store suite.
