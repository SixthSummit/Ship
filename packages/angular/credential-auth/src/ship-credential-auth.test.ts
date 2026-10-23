import { describe, expect, it, vi } from 'vitest';
import type { ShipCredentialAuthCallResult } from './credential-auth-contract';
import { memorySessionStorage } from './session-storage';
import { ShipCredentialAuth } from './ship-credential-auth';

const account = {
  id: 'acc-1',
  email: 'ada@example.test',
  status: 'active' as const,
  roles: ['analyst'],
  emailVerified: true,
  mfaEnabled: true,
  createdAt: '2026-10-23T12:00:00.000Z',
};
const session = (mfaState: 'none' | 'verified' | 'pending-enrolment' = 'verified') => ({
  transport: 'bearer' as const,
  token: `ship_s_${mfaState}`,
  id: `s-${mfaState}`,
  expiresAt: '2026-11-22T12:00:00.000Z',
  mfaState,
});

function fakeClient(answers: Record<string, (input: unknown) => ShipCredentialAuthCallResult>) {
  const call = vi.fn(
    async (operation: string, input: unknown): Promise<ShipCredentialAuthCallResult> => {
      const answer = answers[operation];
      if (!answer) throw new Error(`unexpected ${operation}`);
      return answer(input);
    }
  );
  return { call };
}

describe('ShipCredentialAuth', () => {
  it('signs in through the MFA challenge, stores the bearer and signs out', async () => {
    const storage = memorySessionStorage();
    const client = fakeClient({
      'auth.sign-in': () => ({
        ok: true,
        status: 200,
        data: { status: 'mfa-required', challenge: { token: 'ship_c_1', expiresAt: 'later' } },
      }),
      'auth.totp.verify': input => {
        const body = (input as { body: { challenge: string; code: string } }).body;
        return body.code === '123456'
          ? { ok: true, status: 200, data: { status: 'signed-in', session: session(), account } }
          : {
              ok: false,
              status: 401,
              error: { code: 'AUTH_MFA_INVALID_CODE', message: 'nope' },
            };
      },
      'auth.sign-out': () => ({ ok: true, status: 200, data: { signedOut: true } }),
    });
    const auth = new ShipCredentialAuth({ client, storage });
    expect(auth.state()).toEqual({ status: 'unknown' });
    await expect(auth.initialize()).resolves.toEqual({ status: 'anonymous' });

    const result = await auth.signIn('ada@example.test', 'pw');
    expect(result?.status).toBe('mfa-required');
    expect(auth.state()).toMatchObject({ status: 'challenged', challenge: { token: 'ship_c_1' } });
    expect(storage.read()).toBeNull();

    expect(await auth.verifyTotp('000000')).toBeUndefined();
    expect(auth.failure()).toMatchObject({
      operation: 'auth.totp.verify',
      code: 'AUTH_MFA_INVALID_CODE',
    });
    expect(auth.state().status).toBe('challenged');

    const passed = await auth.verifyTotp('123456');
    expect(passed?.status).toBe('signed-in');
    expect(client.call).toHaveBeenLastCalledWith('auth.totp.verify', {
      body: { challenge: 'ship_c_1', code: '123456' },
    });
    expect(auth.failure()).toBeUndefined();
    expect(auth.signedIn()).toBe(true);
    expect(auth.account()?.email).toBe('ada@example.test');
    expect(storage.read()).toBe('ship_s_verified');
    await expect(auth.getToken()).resolves.toBe('ship_s_verified');

    await auth.signOut();
    expect(client.call).toHaveBeenLastCalledWith('auth.sign-out', {});
    expect(storage.read()).toBeNull();
    expect(auth.state()).toEqual({ status: 'anonymous' });
  });

  it('restores a stored bearer through me, drops a dead one and surfaces lockouts with Retry-After', async () => {
    const storage = memorySessionStorage();
    storage.write('ship_s_old');
    let alive = true;
    const client = fakeClient({
      'auth.me': () =>
        alive
          ? {
              ok: true,
              status: 200,
              data: {
                account,
                session: {
                  ...session('pending-enrolment'),
                  current: true,
                  createdAt: 'x',
                  lastSeenAt: 'x',
                },
              },
            }
          : { ok: false, status: 401, error: { code: 'AUTHENTICATION_ERROR', message: 'no' } },
      'auth.sign-in': () => ({
        ok: false,
        status: 423,
        error: { code: 'AUTH_ACCOUNT_LOCKED', message: 'locked' },
        headers: { retryAfterMs: 120_000 },
      }),
    });
    const auth = new ShipCredentialAuth({ client, storage, prefix: 'auth' });
    await expect(auth.initialize()).resolves.toMatchObject({ status: 'enrolment-required' });
    expect(auth.signedIn()).toBe(false);
    expect(auth.account()?.id).toBe('acc-1');

    alive = false;
    await expect(auth.initialize()).resolves.toEqual({ status: 'anonymous' });
    expect(storage.read()).toBeNull();
    expect(auth.failure()).toBeUndefined();

    expect(await auth.signIn('ada@example.test', 'pw')).toBeUndefined();
    expect(auth.failure()).toMatchObject({ code: 'AUTH_ACCOUNT_LOCKED', retryAfterSeconds: 120 });
    expect(auth.busy()).toBe(false);
  });

  it('returns to anonymous when the challenge expired and keeps recovery codes after enrolment', async () => {
    const client = fakeClient({
      'auth.sign-in': () => ({
        ok: true,
        status: 200,
        data: { status: 'mfa-required', challenge: { token: 'ship_c_2', expiresAt: 'later' } },
      }),
      'auth.recovery.consume': () => ({
        ok: false,
        status: 400,
        error: { code: 'AUTH_TOKEN_INVALID', message: 'expired' },
      }),
      'auth.totp.confirm': () => ({ ok: true, status: 200, data: { recoveryCodes: ['a-b-c-d'] } }),
    });
    const auth = new ShipCredentialAuth({
      client: () => client,
      prefix: 'auth',
      storage: memorySessionStorage(),
    });
    await auth.signIn('ada@example.test', 'pw');
    expect(await auth.recover('aaaaa-bbbbb-ccccc-ddddd')).toBeUndefined();
    expect(auth.state()).toEqual({ status: 'anonymous' });
    expect(await auth.recover('aaaaa-bbbbb-ccccc-ddddd')).toBeUndefined();

    expect(await auth.confirmTotp('123456')).toEqual(['a-b-c-d']);
    expect(auth.recoveryCodes()).toEqual(['a-b-c-d']);
    auth.clearRecoveryCodes();
    expect(auth.recoveryCodes()).toBeUndefined();
  });

  it('defaults to cookie mode: asks for the cookie transport, keeps no token and always asks me', async () => {
    const cookieSession = {
      transport: 'cookie' as const,
      id: 's-c',
      expiresAt: 'later',
      mfaState: 'none' as const,
    };
    let signedIn = false;
    const client = fakeClient({
      'auth.me': () =>
        signedIn
          ? {
              ok: true,
              status: 200,
              data: {
                account,
                session: { ...cookieSession, current: true, createdAt: 'x', lastSeenAt: 'x' },
              },
            }
          : { ok: false, status: 401, error: { code: 'AUTHENTICATION_ERROR', message: 'no' } },
      'auth.sign-in': () => {
        signedIn = true;
        return {
          ok: true,
          status: 200,
          data: { status: 'signed-in', session: cookieSession, account },
        };
      },
      'auth.totp.confirm': () => ({
        ok: true,
        status: 200,
        data: {
          recoveryCodes: ['a-b-c-d'],
          session: { ...cookieSession, id: 's-rotated', mfaState: 'verified' },
        },
      }),
      'auth.sign-out': () => {
        signedIn = false;
        return { ok: true, status: 200, data: { signedOut: true } };
      },
    });
    const auth = new ShipCredentialAuth({ client });
    expect(auth.transport).toBe('cookie');
    await expect(auth.initialize()).resolves.toEqual({ status: 'anonymous' });
    expect(client.call).toHaveBeenCalledWith('auth.me', {}); // the cookie is the browser's to send

    await auth.signIn('ada@example.test', 'pw');
    expect(client.call).toHaveBeenLastCalledWith('auth.sign-in', {
      body: { email: 'ada@example.test', password: 'pw', transport: 'cookie' },
    });
    expect(auth.state()).toEqual({ status: 'signed-in', account, session: cookieSession });
    await expect(auth.getToken()).resolves.toBeNull();
    expect(JSON.stringify(auth.state())).not.toContain('ship_s_');
    expect(globalThis.localStorage.length).toBe(0);
    expect(auth.credential()).toMatchObject({
      kind: 'cookie',
      credentials: 'include',
      csrfHeaderName: 'x-csrf-token',
    });

    // A reload restores the session from the cookie alone.
    const reloaded = new ShipCredentialAuth({ client });
    await expect(reloaded.initialize()).resolves.toMatchObject({
      status: 'signed-in',
      session: cookieSession,
    });

    // Enrolment rotates the cookie session; the state adopts the replacement without a token.
    await auth.confirmTotp('123456');
    expect(auth.state()).toMatchObject({
      status: 'signed-in',
      session: { transport: 'cookie', id: 's-rotated', mfaState: 'verified' },
    });

    await auth.signOut();
    expect(client.call).toHaveBeenLastCalledWith('auth.sign-out', {});
    expect(auth.state()).toEqual({ status: 'anonymous' });
    await auth.signOut();
    expect(
      client.call.mock.calls.filter(([operation]) => operation === 'auth.sign-out')
    ).toHaveLength(1);
  });

  it('changes the password, adopts the rotated session and drops the other sessions', async () => {
    const storage = memorySessionStorage();
    const view = (id: string, current: boolean) => ({
      id,
      createdAt: '2026-10-23T12:00:00.000Z',
      expiresAt: '2026-11-22T12:00:00.000Z',
      lastSeenAt: '2026-10-23T12:00:00.000Z',
      mfaState: 'verified' as const,
      current,
    });
    const client = fakeClient({
      'auth.sign-in': () => ({
        ok: true,
        status: 200,
        data: { status: 'signed-in', session: session(), account },
      }),
      'auth.sessions.list': () => ({
        ok: true,
        status: 200,
        data: { sessions: [view('s-verified', true), view('s-other', false)] },
      }),
      'auth.change-password': input => {
        const body = (input as { body: { currentPassword: string } }).body;
        return body.currentPassword === 'pw'
          ? {
              ok: true,
              status: 200,
              data: {
                changed: true,
                revoked: 1,
                session: { ...session(), token: 'ship_s_rotated', id: 's-rotated' },
              },
            }
          : {
              ok: false,
              status: 401,
              error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'nope' },
            };
      },
    });
    const auth = new ShipCredentialAuth({ client, storage });
    await auth.signIn('ada@example.test', 'pw');
    await auth.loadSessions();
    expect(auth.sessions()).toHaveLength(2);

    expect(await auth.changePassword('wrong', 'new password')).toBe(false);
    expect(auth.failure()).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(storage.read()).toBe('ship_s_verified');
    expect(auth.sessions()).toHaveLength(2);

    expect(await auth.changePassword('pw', 'new password')).toBe(true);
    expect(client.call).toHaveBeenLastCalledWith('auth.change-password', {
      body: { currentPassword: 'pw', newPassword: 'new password', signOutOtherSessions: true },
    });
    expect(storage.read()).toBe('ship_s_rotated');
    expect(auth.state()).toMatchObject({
      status: 'signed-in',
      session: { id: 's-rotated', token: 'ship_s_rotated' },
    });
    expect(auth.sessions()).toEqual([view('s-verified', true)]);
  });

  it('drops a token a server sends to a cookie-mode client and exposes a bearer capability otherwise', async () => {
    const client = fakeClient({
      'auth.sign-in': () => ({
        ok: true,
        status: 200,
        data: { status: 'signed-in', session: session('none'), account },
      }),
    });
    const cookie = new ShipCredentialAuth({ client });
    await cookie.signIn('ada@example.test', 'pw');
    expect(cookie.state()).toMatchObject({ session: { transport: 'cookie', id: 's-none' } });
    expect(JSON.stringify(cookie.state())).not.toContain('token');

    const storage = memorySessionStorage();
    const bearer = new ShipCredentialAuth({ client, storage });
    expect(bearer.transport).toBe('bearer');
    await bearer.signIn('ada@example.test', 'pw');
    expect(client.call).toHaveBeenLastCalledWith('auth.sign-in', {
      body: { email: 'ada@example.test', password: 'pw' },
    });
    expect(storage.read()).toBe('ship_s_none');
    const capability = bearer.credential();
    expect(capability.kind).toBe('bearer');
    if (capability.kind === 'bearer') {
      await expect(
        capability.getToken({
          operation: 'x' as never,
          attempt: 1,
          signal: new AbortController().signal,
        })
      ).resolves.toBe('ship_s_none');
    }
  });
});
