import {
  type CredentialAuthPolicyOptions,
  type CredentialSessionOptions,
  type CredentialStore,
  credentialSessionCsrfPolicy,
  DEFAULT_CREDENTIAL_AUTH_POLICIES,
  defineCredentialAuthMailer,
  defineCredentialAuthModule,
  type RequestClientRegistry,
  resolveSessionPolicy,
  type SecretKeyRing,
} from "@sixthsummit/ship-auth-credentials";
import type { HonoPreValidationPolicy } from "@sixthsummit/ship-hono";
import type { MailDelivery } from "@sixthsummit/ship-mail";
import type { reportsMailer } from "./mail.js";

/** Where the single-use links in verification, reset and change-email mail point. */
export const APP_URL = "https://portfolio.golden.test";

/**
 * Development key ring for sealing TOTP secrets at rest. A deployment reads
 * its 32-byte key from configuration and rotates by adding a key id and
 * switching `current`; the fixture keeps one so tests stay deterministic.
 */
export const DEVELOPMENT_AUTH_SECRETS: SecretKeyRing = {
  current: "dev-1",
  keys: { "dev-1": "6f".repeat(32) },
};

/** Roles a credential account may carry; the resolver maps them to the same slugs as session tokens. */
export const credentialRoles = ["analyst", "publisher", "operator", "sre"] as const;
export type CredentialRole = (typeof credentialRoles)[number];

/**
 * The mailer the auth module declares (`auth.mailer`): verification, reset
 * and change-email messages rendered from the package templates, delivered
 * through the application's one `mail.deliver` job.
 */
export const authMailer = defineCredentialAuthMailer({
  from: "Portfolio <auth@example.test>",
  replyTo: "support@example.test",
  appName: "Portfolio",
});

/**
 * Operator-grade policy: the `sre` role (the one holding `console.operate`)
 * must enrol in TOTP before its session is usable; everyone else may enrol.
 * Lockout, session and token policies are configuration, not code.
 */
export const credentialAuthPolicies: CredentialAuthPolicyOptions = {
  password: { minLength: 12 },
  lockout: { threshold: 5, windowMs: 15 * 60_000, durationMs: 15 * 60_000 },
  session: { maxAgeMs: 30 * 24 * 60 * 60_000, idleTimeoutMs: 12 * 60 * 60_000 },
  mfa: { required: (account) => account.roles.includes("sre"), issuer: "Portfolio" },
};

/**
 * Both session transports (SAPI-762): the browser app signs in over the
 * `httpOnly` cookie (nothing readable from script, reload-safe), native and
 * machine clients keep the bearer. The cookie attributes are the package
 * defaults (`ship_session`, `Secure`, `SameSite=Lax`, `Path=/`), and the
 * `ship_csrf` cookie is echoed in `x-csrf-token`.
 */
export const credentialSessions: CredentialSessionOptions = { transport: "both" };
export const credentialSessionPolicy = resolveSessionPolicy(credentialSessions);

/**
 * The CSRF guard for cookie sessions, registered under the adapter's `"*"`
 * pre-validation key so it runs on every operation after actor resolution:
 * the trusted origins are exactly the CORS allowlist.
 */
export function credentialSessionCsrf(trustedOrigins: readonly string[]): HonoPreValidationPolicy {
  return credentialSessionCsrfPolicy({
    auth: {
      id: "auth",
      sessions: credentialSessionPolicy,
      policies: {
        session: {
          maxAgeMs:
            credentialAuthPolicies.session?.maxAgeMs ??
            DEFAULT_CREDENTIAL_AUTH_POLICIES.session.maxAgeMs,
        },
      },
    },
    trustedOrigins,
  });
}

export function createCredentialAuthModule(definition: {
  readonly store: CredentialStore;
  readonly mail: MailDelivery<readonly [typeof reportsMailer, typeof authMailer]>["dependency"];
  readonly secrets?: SecretKeyRing;
  /** Required by cookie mode: shared with the HTTP adapter so the module knows how a request authenticated. */
  readonly clients: RequestClientRegistry;
  readonly clock?: () => Date;
}) {
  return defineCredentialAuthModule({
    store: definition.store,
    mailer: authMailer,
    mail: definition.mail,
    // The sender enqueues through the job backend `portfolio` exports.
    imports: ["portfolio"],
    links: {
      verifyEmail: (token) => `${APP_URL}/verify/${token}`,
      resetPassword: (token) => `${APP_URL}/reset/${token}`,
      changeEmail: (token) => `${APP_URL}/email/${token}`,
      signIn: `${APP_URL}/sign-in`,
    },
    secrets: definition.secrets ?? DEVELOPMENT_AUTH_SECRETS,
    policies: credentialAuthPolicies,
    sessions: credentialSessions,
    // Self-registered accounts start as analysts; operators promote roles out of band.
    defaultRoles: ["analyst"],
    clients: definition.clients,
    ...(definition.clock ? { clock: definition.clock } : {}),
  });
}
