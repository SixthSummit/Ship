import {
  AuthService,
  FirebaseAuthAdapter,
  Logger,
  SessionAuthAdapter,
} from '@sixthsummit/ship-angular';

export const legacyAuthProviders = [AuthService, FirebaseAuthAdapter, Logger, SessionAuthAdapter];
