import { GoogleOAuthAdapter, type GoogleOAuthAdapterOptions } from "./GoogleOAuthAdapter.js";

/**
 * Gmail-flavored Google OAuth adapter — convenience subclass that
 * pre-fills `providerCode: "gmail"`.
 *
 * Same OAuth 2.0 flow as `GoogleOAuthAdapter` (Gmail uses the same
 * Google Identity endpoints; Gmail-specific scopes like
 * `https://www.googleapis.com/auth/gmail.readonly` are caller-
 * supplied via `AuthUrlOptions.scopes`, not adapter-specific).
 *
 * Why a separate class instead of a runtime tag: connection rows
 * carry `providerCode` as the cross-table key, and consumers
 * frequently want Gmail-scoped connections to live alongside
 * generic Google sign-in connections without colliding on the
 * unique (account_id, provider_code) composite. Registering both
 * `GoogleOAuthAdapter` (`"google"`) and `GmailOAuthAdapter`
 * (`"gmail"`) in the same registry gives consumers two distinct
 * provider rows per account.
 *
 * Usage:
 *
 *   const adapters = oauthAdapterRegistry(
 *     new GoogleOAuthAdapter(),
 *     new GmailOAuthAdapter(),
 *   );
 *
 * All other options forward to the underlying `GoogleOAuthAdapter`
 * (defaultAccessType, defaultPrompt, fetchImpl, …).
 */
export class GmailOAuthAdapter extends GoogleOAuthAdapter {
  constructor(opts: Omit<GoogleOAuthAdapterOptions, "providerCode"> = {}) {
    super({ ...opts, providerCode: "gmail" });
  }
}
