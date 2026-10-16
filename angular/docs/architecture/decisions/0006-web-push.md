# ADR 0006 — Optional Web Push

Status: Accepted
Date: 2026-10-16

## Context

Realtime sockets serve running clients. User-visible notifications while the app is
closed require the browser Push API and a service worker. Push subscriptions are
credentials associated with an application actor, tenant, and device.

## Decision

Add `@sixthsummit/ship-angular/push` as an independent entrypoint with the optional
`@angular/service-worker` peer. Reuse Angular's PWA/service worker installation and
`SwPush`; do not ship or register another worker. Expose signals, explicit permission
requests, subscription synchronization, messages, clicks, and an SSR no-op.

Applications supply authenticated, idempotent save/remove callbacks. Observe restored
and rotated subscriptions without assigning ownership automatically. Explicitly remove
server ownership before local revocation, and before changing authentication identity.
Partial failures are visible and retryable by the application. Injector destruction
only stops observers and does not revoke a durable subscription.

The optional Node package `@sixthsummit/ship-push` uses `web-push` for encryption and
instance-scoped VAPID credentials. Validate subscription keys, require exact trusted
HTTPS origins, bound payload/TTL/socket timeout, and redact provider errors. Return
accepted/expired/retryable/rejected outcomes without internal retry or persistence.

## Consequences

Core bundles do not acquire push dependencies. Apps own the database, authorization,
identity changes, offline policy, outbox/jobs, retries, cleanup, and safe click routes.
Subscription persistence and browser permission changes cannot be atomic. Provider
acceptance is not device-delivery evidence. Real-device acceptance needs separate
application credentials, HTTPS deployment, and browser/OS testing.

Implementation and consumer setup: [Web Push guide](../../guides/WEB_PUSH.md).
