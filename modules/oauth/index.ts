/**
 * OAuth module — public barrel.
 *
 * Multi-step OAuth flow with pluggable provider adapters
 * (Google / Microsoft / Gmail / Outlook), state signing, and
 * connection persistence. Wired via `defineOAuthRoutes(app, deps)`.
 */

export { GmailOAuthAdapter } from "./adapters/GmailOAuthAdapter.js";
export {
  GoogleOAuthAdapter,
  type GoogleOAuthAdapterOptions,
} from "./adapters/GoogleOAuthAdapter.js";
export {
  MicrosoftOAuthAdapter,
  type MicrosoftOAuthAdapterOptions,
} from "./adapters/MicrosoftOAuthAdapter.js";
export { MockOAuthAdapter } from "./adapters/MockOAuthAdapter.js";
export {
  type AuthUrlOptions,
  InvalidCredentialsError,
  type OAuthAdapter,
  OAuthAdapterError,
  type OAuthClientCredentials,
  OAuthRateLimitError,
  TokenExchangeError,
  TokenRefreshError,
  type TokenResponse,
} from "./adapters/OAuthAdapter.js";
export { OAuthAdapterRegistry, oauthAdapterRegistry } from "./adapters/OAuthAdapterRegistry.js";
export { OutlookOAuthAdapter } from "./adapters/OutlookOAuthAdapter.js";
export {
  OAUTH_PERMISSION_DEFINITIONS,
  OAUTH_PERMISSIONS,
  type OAuthPermission,
} from "./permissions.js";
export {
  buildOAuthApp,
  defineOAuthRoutes,
  type OAuthCredentialsResolver,
  type OAuthRoutesDeps,
  validateReturnTo,
} from "./routes.js";
export {
  authorizationHeader,
  isActive,
  isExpired,
  isExpiringSoon,
  type NewOAuthConnection,
  needsRefresh,
  type OAuthConnection,
  oauthConnections,
  oauthConnectionsRelations,
} from "./schema.js";
export { OAuthConnectionService } from "./services/OAuthConnectionService.js";
export {
  InvalidStateError,
  type SignStateOptions,
  type StatePayload,
  type StateSecret,
  signState,
  type VerifyStateOptions,
  verifyState,
} from "./state.js";

/**
 * OAuth state replay defense (F16). Default in-memory cache ships
 * with the framework; consumers running behind a load balancer
 * implement `StateJtiCache` against shared storage (e.g. Redis) and
 * pass it via `OAuthRoutesDeps.stateJtiCache`.
 */
export { InMemoryStateJtiCache, type StateJtiCache } from "./stateJtiCache.js";
/**
 * `@internal` OIDC id_token verifier (F13). No adapter currently
 * consumes id_token as an identity decision; this helper exists so
 * any future code path that does MUST route through it (signature +
 * iss/aud/exp + nonce echo against framework-signed state).
 */
export { type VerifyIdTokenOptions, verifyIdToken } from "./verifyIdToken.js";
