import type { AuthCapabilityName } from '../adapters/AuthAdapter';

/** A UI or service invoked an auth action the configured provider does not advertise. */
export class AuthCapabilityUnavailableError extends Error {
  readonly kind = 'auth-capability-unavailable' as const;
  readonly capability: AuthCapabilityName;

  constructor(capability: AuthCapabilityName) {
    super(`Authentication capability is unavailable: ${capability}`);
    this.name = 'AuthCapabilityUnavailableError';
    this.capability = capability;
  }
}
