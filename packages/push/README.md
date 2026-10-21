# @sixthsummit/ship-push

Optional Node Web Push adapter for Ship applications, using standard VAPID signing
and encrypted `web-push` delivery. Initial release is pending in the root Changeset.

```ts
import { createWebPushSender } from '@sixthsummit/ship-push';

const sender = createWebPushSender({
  vapid: { subject: env.pushSubject, publicKey: env.pushPublicKey, privateKey: env.pushPrivateKey },
  allowedPushOrigins: env.pushAllowedOrigins,
});
const result = await sender.send(subscription, {
  title: 'Export ready', body: 'Open the app for details.', tag: 'export-ready',
});
```

Configure exact trusted HTTPS push-service origins. Validate untrusted registration
input with `parsePushSubscription(input, allowedPushOrigins)` before storing it under
the authenticated actor and authorized tenant. Subscription endpoints/keys and the
VAPID private key are credentials. Do not log them.

`accepted` means provider acceptance, not device delivery. Delete matching expired
subscriptions (404/410); retry network/429/5xx outcomes with bounded job backoff;
inspect other rejections. No database, routes, automatic retries, or global VAPID
state are installed. Notification payloads use Angular's service-worker format.

See the [complete guide](https://github.com/SixthSummit/Ship/blob/dev/angular/docs/guides/WEB_PUSH.md)
for Angular PWA setup, typed callbacks, ownership, unsubscribe recovery, limits, click
handling, and device verification. Node 22 or newer is required.
