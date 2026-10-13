/**
 * `@sixthsummit/ship-webhooks` root entry.
 *
 * Provider verifiers live behind independent subpaths so an application only
 * loads the schemes it binds:
 *
 * - `@sixthsummit/ship-webhooks/stripe`
 * - `@sixthsummit/ship-webhooks/github`
 * - `@sixthsummit/ship-webhooks/slack`
 * - `@sixthsummit/ship-webhooks/twilio`
 * - `@sixthsummit/ship-webhooks/resend`
 * - `@sixthsummit/ship-webhooks/ghl`
 * - `@sixthsummit/ship-webhooks/shared-secret`
 *
 * The verifier contract itself is owned by `@sixthsummit/ship-core`; this
 * entry only re-exports its types for convenience and imports no provider.
 */
export type {
  WebhookVerification,
  WebhookVerificationFailureReason,
  WebhookVerificationRequest,
  WebhookVerifier,
  WebhookVerifierGuarantees,
} from "@sixthsummit/ship-core";

export const WEBHOOK_VERIFIER_SUBPATHS = Object.freeze([
  "stripe",
  "github",
  "slack",
  "twilio",
  "resend",
  "ghl",
  "shared-secret",
] as const);
