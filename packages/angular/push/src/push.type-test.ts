import type { ShipPushOptions, ShipPushSubscription } from './public-api';

const subscription: ShipPushSubscription = {
  endpoint: 'https://push.example.test/device',
  expirationTime: null,
  keys: { p256dh: 'public-encryption-key', auth: 'auth-secret' },
};
const options: ShipPushOptions = {
  serverPublicKey: 'public-vapid-key',
  saveSubscription: async value => {
    const same: ShipPushSubscription = value;
    void same;
  },
  removeSubscription: async () => {},
};
// @ts-expect-error persistence is explicit and cannot be silently omitted
const incomplete: ShipPushOptions = { serverPublicKey: 'key' };
const missingKey: ShipPushSubscription = {
  endpoint: subscription.endpoint,
  expirationTime: null,
  // @ts-expect-error both browser encryption credentials are required
  keys: { auth: 'only-auth' },
};
void [options, incomplete, missingKey];
