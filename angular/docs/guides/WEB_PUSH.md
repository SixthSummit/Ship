# Web Push notifications

Ship provides opt-in Web Push through `@sixthsummit/ship-angular/push` and the Node
adapter `@sixthsummit/ship-push`. These additions are pending release; consult the
root Changeset before choosing a package version. They use the standard Push API
and Angular service worker. Firebase is not required. Delivery is separate from
the `/realtime` socket connection and can occur while the application is closed,
subject to browser, permission, network, and operating-system restrictions.

## Enable Angular's service worker

In a consuming Angular 20 application:

```sh
pnpm exec ng add @angular/pwa@20
```

Use the service-worker package version matching your application's Angular core.
The Angular schematic adds the manifest, icons, `ngsw-config.json`, and worker
registration. Review its asset caching policy. Do not cache authenticated API
responses in a shared service-worker data group. Ship does not register a second
worker or replace the application's offline policy.

Serve a production build over HTTPS (localhost is allowed for development). Keep
registration enabled only in the environments where you intend to use push. The
usual standalone configuration includes:

```ts
import { isDevMode } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';

provideServiceWorker('ngsw-worker.js', {
  enabled: !isDevMode(),
  registrationStrategy: 'registerWhenStable:30000',
});
```

On iPhone and iPad, Web Push requires a supported OS and the web app to be added
to the Home Screen. Permission prompts require a user interaction. Browser support
does not guarantee delivery; test the installed app on the target devices.

## Connect authenticated persistence

Register Ship's provider alongside `provideServiceWorker`. Its options factory
runs in Angular's injection context, so the application can inject its typed
operation client:

```ts
import { provideShipPush } from '@sixthsummit/ship-angular/push';
import { injectAppShipClient } from './api';
import { environment } from './environment';

provideShipPush(() => {
  const client = injectAppShipClient();
  return {
    serverPublicKey: environment.pushVapidPublicKey,
    saveSubscription: async (subscription, signal) => {
      const result = await client.call('push.subscribe', { body: subscription }, { signal });
      if (!result.ok) throw new Error('Subscription was not saved');
    },
    removeSubscription: async (subscription, signal) => {
      const result = await client.call(
        'push.unsubscribe',
        {
          body: { endpoint: subscription.endpoint },
        },
        { signal }
      );
      if (!result.ok) throw new Error('Subscription was not removed');
    },
  };
});
```

`push.subscribe` and `push.unsubscribe` are example application-owned operation IDs,
not built-in routes. Define them in your API and generate the contract/client before
using this snippet. Callbacks must reject on declared API failures; a resolved
callback tells Ship persistence succeeded.

In a component or service, use `injectPush()`. Call `subscribe()` directly from a
button's click handler, before awaiting other work, so the permission prompt retains
the user's activation. Catch the promise and present `push.error()?.code` to the UI.
The subscription itself is credential material: do not display or log it.

The client exposes:

| Member                             | Meaning                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `enabled`                          | Angular worker support is configured and enabled; not a delivery guarantee   |
| `ready()`                          | Initial browser subscription state has arrived                               |
| `subscription()`, `subscribed()`   | Current device subscription                                                  |
| `busy()`, `error()`                | Mutation progress and redacted failure code                                  |
| `latestMessage()`, `latestClick()` | Most recent foreground message and notification click                        |
| `subscribe()`                      | Request permission, create/reuse the browser subscription, then save it      |
| `sync()`                           | Explicitly save an existing or rotated subscription for the current identity |
| `unsubscribe()`                    | Remove server ownership, then revoke the browser subscription                |

An initial subscription is observed without writing to the API. Wait for `ready()`
before `sync()` or `unsubscribe()`; otherwise they reject with `not-ready`. Call
`sync()` after authentication is resolved and when a rotation changes the subscription.
No automatic background write chooses an actor or tenant for you. Remove the previous
actor's registration **before** logout, account switching, or tenant switching. Do not
reassign the same endpoint to a new actor without revoking its previous ownership.

If saving fails, the browser subscription remains available: fix the failure and call
`sync()`, without prompting again. If server removal fails, the browser subscription
remains active and `unsubscribe()` can retry. If the browser rotates its endpoint during server removal, the method rejects with `subscription-changed` before revoking the replacement; retry to remove the new endpoint too. If local removal fails after the server
removal, retry the idempotent operation. Persistence and browser operations cannot form
one atomic transaction. Do not report success until the promise resolves.

SSR returns an unavailable client and never resolves `SwPush`. Destroying an injector
detaches listeners and aborts the persistence signal without deleting the durable browser subscription. Propagate that signal through your operation calls; cancellation cannot undo a write already accepted by the server. Concurrent
mutations reject with `busy`; methods after destruction reject with `closed`.

## Send from ShipAPI

Install the optional Node adapter in the backend:

```sh
pnpm add @sixthsummit/ship-push
```

Generate one VAPID key pair with `pnpm dlx web-push@3.6.7 generate-vapid-keys --json`. Store the private key in your server's
secret manager. Keep the pair stable across deployments; distribute only the public
key to the browser. Changing the pair requires new browser subscriptions.

```ts
import { createWebPushSender, parsePushSubscription } from '@sixthsummit/ship-push';

// Values come from the application's validated server configuration.
const sender = createWebPushSender({
  vapid: {
    subject: env.pushVapidSubject,
    publicKey: env.pushVapidPublicKey,
    privateKey: env.pushVapidPrivateKey,
  },
  allowedPushOrigins: env.pushAllowedOrigins,
  timeoutMs: 10_000,
});

// Inside the authenticated subscribe operation: validate before saving.
const subscription = parsePushSubscription(input.body, env.pushAllowedOrigins);
// Persist it using the verified actor and authorized tenant from the operation context.

// Inside a background job after loading that actor/tenant's subscription:
const result = await sender.send(
  subscription,
  {
    title: 'Your export is ready',
    body: 'Open the app to download it.',
    tag: 'export-ready',
    data: {
      exportId: 'export-1',
      onActionClick: {
        default: { operation: 'navigateLastFocusedOrOpen', url: '/exports' },
      },
    },
  },
  { ttlSeconds: 3600, urgency: 'normal' }
);
```

Provide the sender through a kernel dependency token/value provider or inject it into
your job service. The adapter assumes no account tables, ORM, tenant model, or routes.
The example `env` and `input` objects belong to the application.

`allowedPushOrigins` is a required operator-controlled list of exact HTTPS origins,
without trailing slashes, wildcards, or paths. Populate it from the push services
you support, after verifying those providers. Reject unsupported origins on both
registration and sending. Never build this list from user-submitted endpoints.
This prevents endpoint input from turning the sender into an arbitrary HTTP client.

## Ownership, retries, and lifecycle

- Authenticate registration/removal operations and authorize actor and tenant scope.
  Never trust submitted user IDs. Make endpoint ownership unique or explicitly revoke
  old owners; knowing an endpoint alone must not authorize removing another user's device.
- Encrypt subscription credentials at rest and redact endpoints, auth keys, VAPID
  private keys, provider errors, and sensitive notification content from logs.
- Send after the domain transaction commits. Use the outbox and jobs adapter for
  durable dispatch. There is no automatic fan-out or retry loop in this adapter.
- `accepted` means the provider accepted the message, not that a device received it.
  Remove the matching subscription on `expired` (404/410). On `retryable` (network,
  429, or 5xx), apply bounded job backoff, respecting `retryAfterSeconds` when present
  (numeric Retry-After headers). Inspect configuration/credentials on `rejected`.
  Prevent stale cleanup from deleting a replacement subscription by matching the
  exact endpoint/version. Retrying after a network timeout can produce duplicates.
- The payload limit is 3072 UTF-8 bytes including the `{ notification: ... }` wrapper.
  Payloads must be JSON. TTL defaults to one hour (0–28 days); topic is at most 32
  base64url characters. Use a tag/topic to coalesce where appropriate.
- Keep lock-screen text minimal. Fetch sensitive content after authenticated navigation.

## Notification clicks and validation

The sender produces Angular's `{ notification: { title, ... } }` payload. The example
`onActionClick` opens `/exports` even when no app window is running. Use fixed,
same-origin application routes; do not copy user-provided URLs into click operations.
For custom foreground handling, read `latestClick()` and validate its data before
routing. Do not combine app routing and a worker navigation operation unintentionally.

Verify a production build on an HTTPS test origin: opt in, save the subscription,
close the app, send through a real push provider, tap the notification, then opt out
and verify the server record disappears. Repeat for each supported browser/device.
Automated tests exercise lifecycle, SSR, encrypted request generation, and error
classification; they do not claim real-device delivery through Apple/Google/Mozilla.

See [Angular push notifications](https://angular.dev/ecosystem/service-workers/push-notifications),
[Angular 20 SwPush](https://v20.angular.dev/api/service-worker/SwPush), and
[web-push](https://github.com/web-push-libs/web-push), and
[Apple Web Push requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).
