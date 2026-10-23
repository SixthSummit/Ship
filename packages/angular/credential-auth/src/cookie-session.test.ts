import {
  createPolicyClient,
  type OperationExecutionOptions,
  type OperationExecutor,
  type OperationPolicyMap,
} from '@sixthsummit/ship-angular/operations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShipCredentialAuthContract } from './credential-auth-contract';
import {
  cookieCredentialCapability,
  cookieSessionStorage,
  readBrowserCookie,
} from './session-storage';
import { ShipCredentialAuth } from './ship-credential-auth';

type Contract = ShipCredentialAuthContract;

const account = {
  id: 'acc-1',
  email: 'ada@example.test',
  status: 'active' as const,
  roles: [],
  emailVerified: true,
  mfaEnabled: false,
  createdAt: 'x',
};
const cookieSession = {
  transport: 'cookie' as const,
  id: 's-1',
  expiresAt: 'later',
  mfaState: 'none' as const,
};

/** The policy map a generated manifest projects: public sign-in, CSRF on every unsafe authenticated call. */
const policies = {
  'auth.sign-in': {
    authentication: 'optional',
    safety: 'unsafe',
    idempotency: 'unsupported',
    replayable: true,
    csrf: true,
  },
  'auth.me': {
    authentication: 'required',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
  'auth.sign-out': {
    authentication: 'required',
    safety: 'unsafe',
    idempotency: 'unsupported',
    replayable: true,
    csrf: true,
  },
} as unknown as OperationPolicyMap<Contract>;

function clearCookies(): void {
  for (const name of ['ship_csrf', 'other']) {
    document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

describe('cookie session mode through the client executor', () => {
  afterEach(() => {
    clearCookies();
  });

  it('sends credentials: include, echoes the CSRF cookie in the header and never holds the token', async () => {
    document.cookie = 'other=1; Path=/';
    document.cookie = 'ship_csrf=csrf-from-cookie; Path=/';
    expect(readBrowserCookie('ship_csrf')).toBe('csrf-from-cookie');
    expect(readBrowserCookie('ship_session')).toBeNull();

    const seen: { operation: string; options: OperationExecutionOptions; input: unknown }[] = [];
    const executor: OperationExecutor<Contract> = {
      call: vi.fn(async (operation, input, options) => {
        seen.push({ operation: operation as string, options, input });
        switch (operation) {
          case 'auth.sign-in':
            return {
              ok: true,
              status: 200,
              data: { status: 'signed-in', session: cookieSession, account },
              headers: {},
            } as never;
          case 'auth.me':
            return {
              ok: true,
              status: 200,
              data: {
                account,
                session: { ...cookieSession, current: true, createdAt: 'x', lastSeenAt: 'x' },
              },
              headers: {},
            } as never;
          default:
            return { ok: true, status: 200, data: { signedOut: true }, headers: {} } as never;
        }
      }),
    };
    const storage = cookieSessionStorage();
    const client = createPolicyClient(executor, { policies, credentials: storage.credential() });
    const auth = new ShipCredentialAuth({ client, storage });

    await auth.initialize();
    expect(seen[0]).toMatchObject({
      operation: 'auth.me',
      options: { credentials: 'include' },
    });
    expect(seen[0]?.options.headers).not.toHaveProperty('x-csrf-token');
    expect(seen[0]?.options.headers).not.toHaveProperty('authorization');

    await auth.signIn('ada@example.test', 'pw');
    expect(seen[1]).toMatchObject({
      operation: 'auth.sign-in',
      input: { body: { email: 'ada@example.test', password: 'pw', transport: 'cookie' } },
      options: { credentials: 'include', headers: { 'x-csrf-token': 'csrf-from-cookie' } },
    });
    expect(auth.state()).toEqual({ status: 'signed-in', account, session: cookieSession });
    await expect(auth.getToken()).resolves.toBeNull();
    expect(globalThis.localStorage.length).toBe(0);
    expect(globalThis.sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain('ship_session');

    await auth.signOut();
    expect(seen[2]).toMatchObject({
      operation: 'auth.sign-out',
      options: { credentials: 'include', headers: { 'x-csrf-token': 'csrf-from-cookie' } },
    });
  });

  it('refuses a CSRF-required call before the server set the CSRF cookie, and honours custom names', async () => {
    const executor: OperationExecutor<Contract> = {
      call: vi.fn(async () => ({ ok: true, status: 200, data: {}, headers: {} }) as never),
    };
    const client = createPolicyClient(executor, {
      policies,
      credentials: cookieCredentialCapability(),
    });
    await expect(
      client.call('auth.sign-in', { body: { email: 'a', password: 'b' } })
    ).rejects.toMatchObject({
      name: 'OperationPolicyError',
      reason: 'csrf-unavailable',
    });
    expect(executor.call).not.toHaveBeenCalled();

    document.cookie = 'app_csrf=custom-token; Path=/';
    const custom = createPolicyClient(executor, {
      policies,
      credentials: cookieCredentialCapability({
        csrfCookieName: 'app_csrf',
        csrfHeaderName: 'X-App-CSRF',
      }),
    });
    await custom.call('auth.sign-in', { body: { email: 'a', password: 'b' } });
    expect(executor.call).toHaveBeenLastCalledWith(
      'auth.sign-in',
      { body: { email: 'a', password: 'b' } },
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'x-app-csrf': 'custom-token' }),
      })
    );
    document.cookie = 'app_csrf=; Max-Age=0; Path=/';
  });
});
