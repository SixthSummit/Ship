import {
  MicrosoftOAuthAdapter,
  type MicrosoftOAuthAdapterOptions,
} from "./MicrosoftOAuthAdapter.js";

/**
 * Outlook-flavored Microsoft OAuth adapter — convenience subclass
 * that pre-fills `providerCode: "outlook"`.
 *
 * Same OAuth 2.0 flow as `MicrosoftOAuthAdapter` (Outlook uses the
 * same Azure AD v2.0 endpoints; Outlook/Mail-specific scopes like
 * `https://graph.microsoft.com/Mail.Read` are caller-supplied via
 * `AuthUrlOptions.scopes`, not adapter-specific).
 *
 * Why a separate class instead of a runtime tag: connection rows
 * carry `providerCode` as the cross-table key, and consumers
 * frequently want Outlook-scoped connections to live alongside
 * generic Microsoft sign-in connections without colliding on the
 * unique (account_id, provider_code) composite. Registering both
 * `MicrosoftOAuthAdapter` (`"microsoft"`) and `OutlookOAuthAdapter`
 * (`"outlook"`) in the same registry gives consumers two distinct
 * provider rows per account.
 *
 * Usage:
 *
 *   const adapters = oauthAdapterRegistry(
 *     new MicrosoftOAuthAdapter(),
 *     new OutlookOAuthAdapter(),
 *   );
 *
 * All other options forward to the underlying `MicrosoftOAuthAdapter`
 * (tenant, fetchImpl, …).
 */
export class OutlookOAuthAdapter extends MicrosoftOAuthAdapter {
  constructor(opts: Omit<MicrosoftOAuthAdapterOptions, "providerCode"> = {}) {
    super({ ...opts, providerCode: "outlook" });
  }
}
