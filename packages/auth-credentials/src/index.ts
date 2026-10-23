/**
 * `@sixthsummit/ship-auth-credentials`: first-party credential authentication
 * for Ship applications as declared operations plus a kernel actor provider.
 * The PostgreSQL store lives under `./drizzle` and the ops-console panel
 * under `./console`.
 */
export type { RequestClient, RequestClientRegistry } from "./client.js";
export { createRequestClientRegistry, readRequestClient } from "./client.js";
export type {
  CredentialSessionCookieOptions,
  CredentialSessionCookiePolicy,
  CredentialSessionCsrfOptions,
  CredentialSessionCsrfPolicyOptions,
  CredentialSessionOptions,
  CredentialSessionPolicy,
  CredentialSessionTransport,
} from "./cookie.js";
export {
  clearSessionCookie,
  credentialSessionCsrfPolicy,
  DEFAULT_CSRF_COOKIE_NAME,
  DEFAULT_CSRF_HEADER,
  DEFAULT_SESSION_COOKIE_NAME,
  DEFAULT_SESSION_POLICY,
  generateCsrfToken,
  readCookie,
  resolveSessionPolicy,
  SAFE_HTTP_METHODS,
  serializeCsrfCookie,
  serializeSessionCookie,
} from "./cookie.js";
export * from "./crypto/index.js";
export * from "./errors.js";
export type {
  CredentialAuthMailer,
  CredentialAuthMailerOptions,
  CredentialMailMessage,
  CredentialMailPayload,
} from "./mailer.js";
export { credentialMailPayloadSchema, defineCredentialAuthMailer } from "./mailer.js";
export type { InMemoryCredentialStore } from "./memory-store.js";
export { createInMemoryCredentialStore } from "./memory-store.js";
export type { CredentialAuthModule, CredentialAuthModuleOptions } from "./module.js";
export {
  DEFAULT_CREDENTIAL_AUTH_BASE_PATH,
  DEFAULT_CREDENTIAL_AUTH_MODULE_ID,
  defineCredentialAuthModule,
} from "./module.js";
export type {
  CredentialAuthPolicies,
  CredentialAuthPolicyOptions,
  LockoutPolicy,
  MfaPolicy,
  PasswordPolicy,
  RecoveryCodePolicy,
  SessionPolicy,
  TokenPolicy,
} from "./policy.js";
export { DEFAULT_CREDENTIAL_AUTH_POLICIES, mfaRequiredFor, resolvePolicies } from "./policy.js";
export type {
  CredentialActorResolverOptions,
  CredentialAuthenticationOptions,
  CredentialSessionCredential,
  CredentialSessionCredentialOptions,
  ResolveCredentialActorRequest,
} from "./provider.js";
export {
  credentialActorResolver,
  credentialAuthentication,
  credentialSessionCredentials,
} from "./provider.js";
export type { CredentialAuthRateLimitOptions, RateLimitStore } from "./rate-limit.js";
export {
  createInMemoryRateLimitStore,
  credentialAuthRateLimitPolicies,
  DEFAULT_RATE_LIMITED_OPERATIONS,
} from "./rate-limit.js";
export type { CredentialAuthLinks } from "./runtime.js";
export { CREDENTIAL_IDENTITY_PROVIDER } from "./runtime.js";
export type {
  AuthAccount,
  AuthAccountPatch,
  AuthAccountStatus,
  AuthAuditEvent,
  AuthAuditOutcome,
  AuthAuditQuery,
  AuthCredential,
  AuthMfaSecret,
  AuthSession,
  AuthSessionMfaState,
  AuthToken,
  AuthTokenPurpose,
  CreateAccountResult,
  CredentialStore,
} from "./store.js";
export {
  CREDENTIAL_STORE_ID,
  credentialStoreDependency,
  isCredentialStore,
  normalizeEmail,
} from "./store.js";
export type {
  CredentialAccountView,
  CredentialAuditEventView,
  CredentialSessionTokenView,
  CredentialSessionView,
  CredentialSignInOutput,
} from "./views.js";
export { accountView, auditEventView, sessionView } from "./views.js";
