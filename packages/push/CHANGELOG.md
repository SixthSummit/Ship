# @sixthsummit/ship-push

## 0.1.0

### Minor Changes

- 43b4f82: Add optional Web Push notifications: Angular's `/push` entrypoint provides signal-based
  subscription lifecycle, explicit authenticated persistence, notification messages/clicks,
  and SSR-safe providers on top of Angular's service worker. The new Node `ship-push`
  adapter sends encrypted VAPID notifications with trusted-origin validation, bounded
  payloads, redacted delivery results, and expired/retryable outcomes. Applications retain
  ownership of subscriptions, authorization, worker setup, and background delivery jobs.
