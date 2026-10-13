import {
  createPolicyClient,
  EMPTY_RESPONSE_METADATA,
  type OperationCallOptions,
  type OperationClient,
  type OperationResultOf,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { describe, expect, it, vi } from 'vitest';
import {
  OperationSessionAuthAdapter,
  type SessionAuthOperationMap,
} from './operation-session-auth-adapter';

interface SessionContract {
  readonly 'auth.me': {
    readonly input: Record<string, never>;
    readonly success: {
      readonly 200: { readonly userId: string; readonly emailAddress: string | null };
    };
    readonly errors: 'AUTHENTICATION_ERROR' | 'SESSION_UNAVAILABLE';
    readonly transport: 'http';
  };
  readonly 'auth.login': {
    readonly input: {
      readonly body: { readonly email: string; readonly password: string };
    };
    readonly success: { readonly 204: undefined };
    readonly errors: 'AUTHENTICATION_ERROR';
    readonly transport: 'http';
  };
  readonly 'auth.register': {
    readonly input: {
      readonly body: { readonly email: string; readonly password: string };
    };
    readonly success: { readonly 201: { readonly created: true } };
    readonly errors: 'VALIDATION_ERROR';
    readonly transport: 'http';
  };
  readonly 'auth.logout': {
    readonly input: Record<string, never>;
    readonly success: { readonly 204: undefined };
    readonly errors: 'SESSION_UNAVAILABLE';
    readonly transport: 'http';
  };
  readonly 'auth.refresh': {
    readonly input: Record<string, never>;
    readonly success: { readonly 204: undefined };
    readonly errors: 'AUTHENTICATION_ERROR';
    readonly transport: 'http';
  };
}

type AnyResult = OperationResultOf<SessionContract, keyof SessionContract>;

const operations = {
  me: { operation: 'auth.me', input: () => ({}) },
  signIn: {
    operation: 'auth.login',
    input: credentials => ({ body: credentials }),
  },
  register: {
    operation: 'auth.register',
    input: credentials => ({ body: credentials }),
  },
  signOut: { operation: 'auth.logout', input: () => ({}) },
  refresh: { operation: 'auth.refresh', input: () => ({}) },
} as const satisfies SessionAuthOperationMap<SessionContract>;

function clientFrom(
  handler: (
    operation: keyof SessionContract,
    input: unknown,
    options: OperationCallOptions | undefined
  ) => Promise<AnyResult>
): OperationClient<SessionContract> {
  return {
    call: handler as OperationClient<SessionContract>['call'],
  };
}

function meSuccess(userId = 'user-1'): AnyResult {
  return {
    ok: true,
    status: 200,
    data: { userId, emailAddress: `${userId}@example.test` },
    headers: EMPTY_RESPONSE_METADATA,
  };
}

function noContent(): AnyResult {
  return {
    ok: true,
    status: 204,
    data: undefined,
    headers: EMPTY_RESPONSE_METADATA,
  };
}

function failure(status: number, code = 'SESSION_UNAVAILABLE'): AnyResult {
  return {
    ok: false,
    status,
    error: {
      declared: code === 'SESSION_UNAVAILABLE',
      code,
      message: 'Session unavailable',
      requestId: 'request-failure',
    },
    headers: { headers: {}, requestId: 'request-failure' },
  };
}

function createAdapter(
  client: OperationClient<SessionContract>,
  overrides: Partial<
    ConstructorParameters<typeof OperationSessionAuthAdapter<SessionContract>>[0]
  > = {}
): OperationSessionAuthAdapter<SessionContract> {
  return new OperationSessionAuthAdapter<SessionContract>({
    client,
    operations,
    mapUser: value => {
      const user = value as { userId: string; emailAddress: string | null };
      return { uid: user.userId, email: user.emailAddress };
    },
    ...overrides,
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('OperationSessionAuthAdapter identity state', () => {
  it.each(['signOut', 'destroy'] as const)(
    'aborts policy refresh when %s supersedes it',
    async action => {
      const pending = deferred<AnyResult>();
      let refreshSignal: AbortSignal | undefined;
      const adapter = createAdapter(
        clientFrom(async (operation, _input, options) => {
          if (operation !== 'auth.refresh') return noContent();
          refreshSignal = options?.signal;
          return pending.promise;
        })
      );
      const refreshed = adapter.credential.refresh!({
        operation: 'auth.me',
        attempt: 1,
        signal: new AbortController().signal,
      });
      const rejected = expect(refreshed).rejects.toMatchObject({ name: 'OperationAbortedError' });
      if (action === 'signOut') await adapter.signOut();
      else adapter.destroy();
      expect(refreshSignal?.aborted).toBe(true);
      pending.resolve(noContent());
      await rejected;
      expect(adapter.state().status).toBe(action === 'signOut' ? 'unauthenticated' : 'unknown');
    }
  );
  it('refreshes expired initialization and replays me without superseding itself', async () => {
    const calls: string[] = [];
    const unsafe = {
      authentication: 'optional',
      safety: 'unsafe',
      idempotency: 'unsupported',
      replayable: false,
    } as const;
    const client = createPolicyClient(
      clientFrom(async (operation, _input, options) => {
        expect(options?.signal?.aborted).toBe(false);
        calls.push(operation);
        return operation === 'auth.refresh'
          ? noContent()
          : calls.length === 1
            ? failure(401, 'AUTHENTICATION_ERROR')
            : meSuccess();
      }),
      {
        policies: {
          'auth.me': {
            authentication: 'required',
            safety: 'safe',
            idempotency: 'unsupported',
            replayable: true,
            refreshAuthentication: true,
          },
          'auth.refresh': unsafe,
          'auth.login': unsafe,
          'auth.register': unsafe,
          'auth.logout': unsafe,
        },
        credentials: { kind: 'cookie', refresh: request => adapter.credential.refresh!(request) },
      }
    );
    const adapter: OperationSessionAuthAdapter<SessionContract> = createAdapter(client);
    await adapter.initialize();
    expect(calls).toEqual(['auth.me', 'auth.refresh', 'auth.me']);
    expect(adapter.state().status).toBe('authenticated');
  });
  it('performs no constructor I/O and initializes authenticated identity explicitly', async () => {
    const call = vi.fn(async () => meSuccess());
    const adapter = createAdapter(clientFrom(call));

    expect(call).not.toHaveBeenCalled();
    expect(adapter.state().status).toBe('unknown');

    await adapter.initialize();

    expect(adapter.state()).toEqual({
      status: 'authenticated',
      user: { uid: 'user-1', email: 'user-1@example.test' },
      idToken: null,
    });
  });

  it('uses unauthenticated only for an authoritative 401', async () => {
    const adapter = createAdapter(clientFrom(async () => failure(401, 'AUTHENTICATION_ERROR')));

    await adapter.initialize();

    expect(adapter.state()).toEqual({ status: 'unauthenticated' });
  });

  it('keeps server and transport uncertainty distinct from signed-out state', async () => {
    const server = createAdapter(clientFrom(async () => failure(503)));
    const transport = createAdapter(
      clientFrom(async () => Promise.reject(new TransportError('offline')))
    );

    await server.initialize();
    await transport.initialize();

    expect(server.state()).toMatchObject({
      status: 'indeterminate',
      issue: {
        kind: 'operation',
        retryable: true,
        requestId: 'request-failure',
      },
    });
    expect(transport.state()).toMatchObject({
      status: 'indeterminate',
      issue: { kind: 'transport', retryable: true },
    });
  });

  it('turns invalid mapped identity into a safe protocol issue', async () => {
    const adapter = createAdapter(
      clientFrom(async () => meSuccess()),
      {
        mapUser: () => {
          throw new Error('raw decoder details');
        },
      }
    );

    await adapter.initialize();

    expect(adapter.state()).toMatchObject({
      status: 'indeterminate',
      issue: {
        kind: 'protocol',
        message: 'The session response did not match its client contract',
        retryable: false,
      },
    });
    expect(JSON.stringify(adapter.state())).not.toContain('raw decoder details');
  });

  it('retains the last confirmed user when a later probe becomes indeterminate', async () => {
    let calls = 0;
    const adapter = createAdapter(
      clientFrom(async () => {
        calls += 1;
        return calls === 1 ? meSuccess('known-user') : failure(503);
      })
    );
    await adapter.initialize();

    await adapter.initialize();

    expect(adapter.state()).toMatchObject({
      status: 'indeterminate',
      previousUser: { uid: 'known-user' },
    });
  });

  it('classifies unknown provider exceptions without retaining their details', async () => {
    const adapter = createAdapter(
      clientFrom(async () => Promise.reject(new Error('provider cookie secret')))
    );

    await adapter.initialize();

    expect(adapter.state()).toMatchObject({
      status: 'indeterminate',
      issue: { kind: 'provider', retryable: true },
    });
    expect(JSON.stringify(adapter.state())).not.toContain('provider cookie secret');
  });

  it('rejects an already-aborted initialization without publishing identity', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createAdapter(clientFrom(async () => meSuccess()));

    await expect(adapter.initialize(controller.signal)).rejects.toMatchObject({
      name: 'OperationAbortedError',
    });
    expect(adapter.state().status).toBe('unknown');
  });

  it('suppresses stale identity results when initialization is superseded', async () => {
    const first = deferred<AnyResult>();
    let calls = 0;
    const adapter = createAdapter(
      clientFrom(async () => {
        calls += 1;
        return calls === 1 ? first.promise : meSuccess('latest');
      })
    );

    const stale = adapter.initialize();
    await adapter.initialize();
    first.resolve(meSuccess('stale'));

    await expect(stale).rejects.toMatchObject({ name: 'OperationAbortedError' });
    expect(adapter.state()).toMatchObject({
      status: 'authenticated',
      user: { uid: 'latest' },
    });
  });
});

describe('OperationSessionAuthAdapter actions and credentials', () => {
  it('derives advertised actions from the supplied operation map', () => {
    const client = clientFrom(async () => meSuccess());
    const full = createAdapter(client);
    const readOnly = createAdapter(client, { operations: { me: operations.me } });

    expect(full.capabilities.password?.register).toBeTypeOf('function');
    expect(full.capabilities.signOut?.signOut).toBeTypeOf('function');
    expect(readOnly.capabilities).toEqual({});
  });

  it('signs in through an operation and then establishes current identity', async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const adapter = createAdapter(
      clientFrom(async (operation, requestInput) => {
        calls.push({ operation, input: requestInput });
        return operation === 'auth.me' ? meSuccess() : noContent();
      })
    );

    await adapter.signIn('ada@example.test', 'secret');

    expect(calls).toEqual([
      {
        operation: 'auth.login',
        input: { body: { email: 'ada@example.test', password: 'secret' } },
      },
      { operation: 'auth.me', input: {} },
    ]);
    expect(adapter.state().status).toBe('authenticated');
  });

  it('registers through its typed operation before establishing identity', async () => {
    const calls: string[] = [];
    const adapter = createAdapter(
      clientFrom(async operation => {
        calls.push(operation);
        return operation === 'auth.me'
          ? meSuccess()
          : operation === 'auth.register'
            ? {
                ok: true,
                status: 201,
                data: { created: true },
                headers: EMPTY_RESPONSE_METADATA,
              }
            : noContent();
      })
    );

    await adapter.register('new@example.test', 'secret');

    expect(calls).toEqual(['auth.register', 'auth.me']);
    expect(adapter.state().status).toBe('authenticated');
  });

  it('preserves authenticated state when sign-out fails', async () => {
    const adapter = createAdapter(
      clientFrom(async operation => {
        if (operation === 'auth.me') return meSuccess();
        return failure(503);
      })
    );
    await adapter.initialize();

    await expect(adapter.signOut()).rejects.toMatchObject({
      name: 'OperationApiError',
      status: 503,
      code: 'SESSION_UNAVAILABLE',
    });
    expect(adapter.state().status).toBe('authenticated');
  });

  it('transitions to unauthenticated only after confirmed sign-out success', async () => {
    const adapter = createAdapter(clientFrom(async () => noContent()));

    await adapter.signOut();

    expect(adapter.state()).toEqual({ status: 'unauthenticated' });
  });

  it('shares refresh and CSRF suppliers with the operation credential policy', async () => {
    const getCsrfToken = vi.fn(async () => 'csrf-current');
    const calls: string[] = [];
    const adapter = createAdapter(
      clientFrom(async operation => {
        calls.push(operation);
        return noContent();
      }),
      { credentials: 'same-origin', getCsrfToken, csrfHeaderName: 'x-ship-csrf' }
    );
    const controller = new AbortController();

    await expect(
      adapter.credential.getCsrfToken?.({
        operation: 'auth.logout',
        attempt: 1,
        signal: controller.signal,
      })
    ).resolves.toBe('csrf-current');
    await adapter.credential.refresh?.({
      operation: 'auth.me',
      attempt: 1,
      signal: controller.signal,
    });

    expect(adapter.credential.credentials).toBe('same-origin');
    expect(adapter.credential.csrfHeaderName).toBe('x-ship-csrf');
    expect(getCsrfToken).toHaveBeenCalledWith(controller.signal);
    expect(calls).toEqual(['auth.refresh']);
  });

  it('aborts active work on destroy and prevents late state changes', async () => {
    const pendingResult = deferred<AnyResult>();
    const adapter = createAdapter(clientFrom(async () => pendingResult.promise));
    const pending = adapter.initialize();

    adapter.destroy();
    pendingResult.resolve(meSuccess('late'));

    await expect(pending).rejects.toMatchObject({ name: 'OperationAbortedError' });
    expect(adapter.state().status).toBe('unknown');
  });

  it('fails direct calls to capabilities omitted from the operation map', async () => {
    const adapter = createAdapter(
      clientFrom(async () => meSuccess()),
      {
        operations: { me: operations.me },
      }
    );

    await expect(adapter.signIn('a@example.test', 'secret')).rejects.toMatchObject({
      capability: 'password',
    });
    await expect(adapter.register('a@example.test', 'secret')).rejects.toMatchObject({
      capability: 'password',
    });
    await expect(adapter.signOut()).rejects.toMatchObject({ capability: 'signOut' });
    await expect(adapter.refresh()).rejects.toMatchObject({ capability: 'bearerToken' });
    expect(adapter.credential.getCsrfToken).toBeUndefined();
    expect(adapter.credential.refresh).toBeUndefined();
  });

  it('rejects 304 for both identity and action operations', async () => {
    const notModified: AnyResult = {
      ok: true,
      notModified: true,
      status: 304,
      headers: EMPTY_RESPONSE_METADATA,
    };
    const identity = createAdapter(clientFrom(async () => notModified));
    await identity.initialize();
    expect(identity.state()).toMatchObject({
      status: 'indeterminate',
      issue: { kind: 'protocol' },
    });

    const action = createAdapter(clientFrom(async () => notModified));
    await expect(action.signOut()).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'unexpected-status',
    });
  });
});
