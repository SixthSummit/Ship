import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { ShipCredentialAuthCallResult } from './credential-auth-contract';
import { ShipMfaChallengeComponent } from './mfa-challenge.component';
import { provideShipCredentialAuth } from './provide-ship-credential-auth';
import { ShipRecoveryCodeComponent } from './recovery-code.component';
import { ShipSignInComponent } from './sign-in.component';

const account = {
  id: 'acc-1',
  email: 'ada@example.test',
  status: 'active',
  roles: [],
  emailVerified: true,
  mfaEnabled: true,
  createdAt: 'x',
};
const session = { token: 'ship_s_x', id: 's1', expiresAt: 'later', mfaState: 'verified' };

function type(element: HTMLElement, selector: string, value: string): void {
  const input = element.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`missing ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function submit(element: HTMLElement): void {
  element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('credential auth screens', () => {
  it('signs in, shows a lockout inline and emits the MFA challenge', async () => {
    let attempts = 0;
    const call = vi.fn(async (operation: string): Promise<ShipCredentialAuthCallResult> => {
      if (operation !== 'auth.sign-in') throw new Error(operation);
      attempts += 1;
      return attempts === 1
        ? {
            ok: false,
            status: 423,
            error: { code: 'AUTH_ACCOUNT_LOCKED', message: 'locked' },
            headers: { retryAfterMs: 30_000 },
          }
        : {
            ok: true,
            status: 200,
            data: { status: 'mfa-required', challenge: { token: 'ship_c_1', expiresAt: 'later' } },
          };
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideShipCredentialAuth({ client: { call } }),
      ],
    });
    const fixture = TestBed.createComponent(ShipSignInComponent);
    const element = fixture.nativeElement as HTMLElement;
    const emitted: unknown[] = [];
    fixture.componentInstance.signedIn.subscribe(result => emitted.push(result));
    await fixture.whenStable();
    expect(element.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);

    type(element, 'input[name=email]', 'ada@example.test');
    type(element, 'input[name=password]', 'correct horse battery staple');
    await fixture.whenStable();
    expect(element.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(false);
    submit(element);
    await fixture.whenStable();
    expect(call).toHaveBeenCalledWith('auth.sign-in', {
      body: { email: 'ada@example.test', password: 'correct horse battery staple' },
    });
    expect(element.querySelector('[role=alert]')?.textContent).toContain('temporarily locked');
    expect(element.querySelector('[role=alert]')?.textContent).toContain('30 s');
    expect(emitted).toEqual([]);

    type(element, 'input[name=password]', 'correct horse battery staple');
    submit(element);
    await fixture.whenStable();
    expect(element.querySelector('[role=alert]')).toBeNull();
    expect(emitted).toEqual([
      { status: 'mfa-required', challenge: { token: 'ship_c_1', expiresAt: 'later' } },
    ]);
  });

  it('answers the challenge with a code, then with a recovery code, and reports expiry', async () => {
    const call = vi.fn(
      async (operation: string, input: unknown): Promise<ShipCredentialAuthCallResult> => {
        switch (operation) {
          case 'auth.sign-in':
            return {
              ok: true,
              status: 200,
              data: {
                status: 'mfa-required',
                challenge: { token: 'ship_c_1', expiresAt: 'later' },
              },
            };
          case 'auth.totp.verify':
            return (input as { body: { code: string } }).body.code === '123456'
              ? { ok: true, status: 200, data: { status: 'signed-in', session, account } }
              : { ok: false, status: 401, error: { code: 'AUTH_MFA_INVALID_CODE', message: 'no' } };
          case 'auth.recovery.consume':
            return {
              ok: false,
              status: 400,
              error: { code: 'AUTH_TOKEN_INVALID', message: 'expired' },
            };
          default:
            throw new Error(operation);
        }
      }
    );
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideShipCredentialAuth({ client: { call } }),
      ],
    });
    const challenge = TestBed.createComponent(ShipMfaChallengeComponent);
    const auth = challenge.componentInstance.auth;
    await auth.signIn('ada@example.test', 'pw');
    const element = challenge.nativeElement as HTMLElement;
    const verified: unknown[] = [];
    const recovery: unknown[] = [];
    challenge.componentInstance.verified.subscribe(result => verified.push(result));
    challenge.componentInstance.useRecoveryCode.subscribe(() => recovery.push('switch'));
    await challenge.whenStable();

    type(element, 'input[name=code]', '000 000');
    submit(element);
    await challenge.whenStable();
    expect(element.querySelector('[role=alert]')?.textContent).toContain('not correct');
    type(element, 'input[name=code]', '123456');
    submit(element);
    await challenge.whenStable();
    expect(verified).toEqual([{ status: 'signed-in', session, account }]);
    expect(auth.signedIn()).toBe(true);
    element.querySelector<HTMLButtonElement>('button[type=button]')?.click();
    expect(recovery).toEqual(['switch']);

    // A second sign-in reaches the recovery screen; an expired challenge sends the person back.
    await auth.signOut().catch(() => undefined);
    await auth.signIn('ada@example.test', 'pw');
    const recover = TestBed.createComponent(ShipRecoveryCodeComponent);
    const expired: unknown[] = [];
    recover.componentInstance.expired.subscribe(() => expired.push('expired'));
    await recover.whenStable();
    type(recover.nativeElement as HTMLElement, 'input[name=code]', 'aaaaa-bbbbb-ccccc-ddddd');
    submit(recover.nativeElement as HTMLElement);
    await recover.whenStable();
    expect(expired).toEqual(['expired']);
    expect(auth.state()).toEqual({ status: 'anonymous' });
  });
});
