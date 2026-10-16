export type ShipPushErrorCode =
  | 'not-ready'
  | 'unavailable'
  | 'permission-denied'
  | 'busy'
  | 'closed'
  | 'subscription-failed'
  | 'subscription-changed'
  | 'persistence-failed';

export class ShipPushError extends Error {
  readonly code: ShipPushErrorCode;
  constructor(code: ShipPushErrorCode) {
    // Raw browser/backend errors can include endpoint credentials. Keep the public error redacted.
    super(`Web Push failed: ${code}`);
    this.code = code;
    this.name = 'ShipPushError';
  }
}
