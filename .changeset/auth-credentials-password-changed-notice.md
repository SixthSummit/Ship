---
"@sixthsummit/ship-auth-credentials": minor
---

`auth.change-password` mails the account's address the new `passwordChanged` message after every successful change, whoever made it. The notice carries a short-lived reset link (`policies.tokens.passwordChangedResetTtlMs`, 10 minutes by default) so an owner who did not make the change can retake the account; earlier reset links are revoked by the change. The response gains `notified`; a notice the mail queue refuses is audited as `password.changed-notice` and does not fail the change. `defineCredentialAuthMailer()` therefore declares five messages; consumers with custom `templates` may add `passwordChanged`.
