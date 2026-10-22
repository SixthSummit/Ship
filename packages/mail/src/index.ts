/**
 * `@sixthsummit/ship-mail`: declared transactional mail delivery on the jobs
 * capability. `defineMailer` and the provider/ledger contracts live in
 * `@sixthsummit/ship-core`; this package owns delivery, the sender facade,
 * the non-production interceptor, previews and the adapters.
 *
 * The Resend adapter is a separate subpath (`@sixthsummit/ship-mail/resend`)
 * and the conformance suites live under `@sixthsummit/ship-mail/conformance`.
 */
export type {
  MailDelivery,
  MailDeliveryErrorCode,
  MailDeliveryInput,
  MailDeliveryOptions,
  MailDeliveryOutput,
  MailSendErrorCode,
  MailSender,
  MailSendOptions,
  MailSendResult,
} from "./delivery.js";
export {
  DEFAULT_MAIL_CLAIM_LEASE_MS,
  DEFAULT_MAIL_DELIVERY_ID,
  DEFAULT_MAIL_RETRY,
  defineMailDelivery,
  MailDeliveryError,
  MailSendError,
  mailDeliveryInputSchema,
  mailMessageUnknown,
  mailPayloadInvalid,
  mailRejected,
} from "./delivery.js";
export type { AllowlistInterceptorOptions } from "./interceptor.js";
export { allowlistInterceptor, MailInterceptorError } from "./interceptor.js";
export type { LoggedMail, LogMailProvider, LogMailProviderOptions } from "./log.js";
export { logMailProvider } from "./log.js";
export type { InMemoryMailLedger } from "./memory-ledger.js";
export { createInMemoryMailLedger } from "./memory-ledger.js";
export type { MailPreview, MailPreviewOptions } from "./preview.js";
export {
  defineMailPreview,
  MAIL_PREVIEW_PERMISSION,
  MailPreviewError,
  mailPreviewNotFound,
  mailPreviewSampleInvalid,
  mailPreviewSampleMissing,
} from "./preview.js";
