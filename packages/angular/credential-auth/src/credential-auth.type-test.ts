import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import type { ShipCredentialAuthClient, ShipCredentialAuthContract } from './public-api';

declare const typed: OperationClient<ShipCredentialAuthContract>;
// A typed operation client over the credential-auth contract is accepted as-is.
const client: ShipCredentialAuthClient = typed;

async function verify(): Promise<void> {
  const signIn = await typed.call('auth.sign-in', { body: { email: 'a@b.c', password: 'p' } });
  if (signIn.ok && signIn.notModified !== true) {
    if (signIn.data.status === 'mfa-required') signIn.data.challenge.token satisfies string;
    if (signIn.data.status === 'signed-in') signIn.data.session.mfaState satisfies string;
  }
  if (!signIn.ok) {
    signIn.error.code satisfies 'AUTH_INVALID_CREDENTIALS' | 'AUTH_ACCOUNT_LOCKED' | (string & {});
  }
  // @ts-expect-error the password is required in the sign-in body
  await typed.call('auth.sign-in', { body: { email: 'a@b.c' } });
  // @ts-expect-error unknown auth operation ids are rejected
  await typed.call('auth.nope', {});
}
void [client, verify];
