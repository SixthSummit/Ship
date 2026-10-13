import { type Signal, signal, type WritableSignal } from '@angular/core';
import {
  type AuthAdapter,
  type AuthAdapterCapabilities,
  AuthCapabilityUnavailableError,
  type AuthState,
  type AuthStateIssue,
  type AuthUser,
} from '@sixthsummit/ship-angular';
import {
  type CookieCredentialCapability,
  type CredentialRequest,
  createOperationCallScope,
  type HttpOperationId,
  type InputOf,
  OperationAbortedError,
  OperationApiError,
  type OperationCallOptions,
  type OperationClient,
  type OperationFailure,
  type OperationResultOf,
  ProtocolError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';

export type SessionAuthOperationBinding<TContract extends object, TArguments> = {
  [TId in HttpOperationId<TContract>]: {
    readonly operation: TId;
    readonly input: (arguments_: TArguments) => InputOf<TContract, TId>;
  };
}[HttpOperationId<TContract>];

export interface SessionCredentials {
  readonly email: string;
  readonly password: string;
}

export interface SessionAuthOperationMap<TContract extends object> {
  readonly me: SessionAuthOperationBinding<TContract, void>;
  readonly signIn?: SessionAuthOperationBinding<TContract, SessionCredentials>;
  readonly register?: SessionAuthOperationBinding<TContract, SessionCredentials>;
  readonly signOut?: SessionAuthOperationBinding<TContract, void>;
  readonly refresh?: SessionAuthOperationBinding<TContract, void>;
}

export interface OperationSessionAuthAdapterConfig<TContract extends object> {
  readonly client: OperationClient<TContract>;
  readonly operations: SessionAuthOperationMap<TContract>;
  /** The operation client has already decoded its contract body; this maps app identity fields. */
  readonly mapUser: (value: unknown) => AuthUser;
  readonly credentials?: 'include' | 'same-origin';
  readonly getCsrfToken?: (signal: AbortSignal) => Promise<string | null>;
  readonly csrfHeaderName?: string;
}

interface ActiveAuthCall {
  readonly generation: number;
  readonly controller: AbortController;
  readonly cleanup: () => void;
}

/** Cookie-session identity adapter driven entirely through structural ShipAPI operations. */
export class OperationSessionAuthAdapter<TContract extends object> implements AuthAdapter {
  private readonly internal: WritableSignal<AuthState> = signal({ status: 'unknown' });
  readonly state: Signal<AuthState> = this.internal.asReadonly();
  readonly capabilities: AuthAdapterCapabilities;
  readonly credential: CookieCredentialCapability<TContract>;

  private readonly client: OperationClient<TContract>;
  private readonly operations: SessionAuthOperationMap<TContract>;
  private readonly mapUser: (value: unknown) => AuthUser;
  private active: ActiveAuthCall | undefined;
  private readonly refreshControllers = new Set<AbortController>();
  private generation = 0;

  constructor(config: OperationSessionAuthAdapterConfig<TContract>) {
    this.client = config.client;
    this.operations = config.operations;
    this.mapUser = config.mapUser;
    this.capabilities = {
      ...(config.operations.signIn === undefined
        ? {}
        : {
            password: {
              signIn: (email: string, password: string) => this.signIn(email, password),
              ...(config.operations.register === undefined
                ? {}
                : {
                    register: (email: string, password: string) => this.register(email, password),
                  }),
            },
          }),
      ...(config.operations.signOut === undefined
        ? {}
        : { signOut: { signOut: () => this.signOut() } }),
    };
    const getCsrfToken = config.getCsrfToken;
    this.credential = {
      kind: 'cookie',
      credentials: config.credentials ?? 'include',
      ...(getCsrfToken === undefined
        ? {}
        : {
            getCsrfToken: (request: CredentialRequest<TContract>) => getCsrfToken(request.signal),
          }),
      ...(config.csrfHeaderName === undefined ? {} : { csrfHeaderName: config.csrfHeaderName }),
      ...(config.operations.refresh === undefined
        ? {}
        : {
            refresh: (request: CredentialRequest<TContract>) =>
              this.refreshCredential(request.signal),
          }),
    };
  }

  /** Establish current identity explicitly; construction never performs I/O. */
  readonly initialize = async (signal?: AbortSignal): Promise<void> => {
    const active = this.begin(signal);
    const previousUser = currentUser(this.internal());
    try {
      const result = await this.callBinding(this.operations.me, undefined, {
        signal: active.controller.signal,
      });
      this.assertCurrent(active);
      if (!result.ok) {
        const failure = result as OperationFailure<string>;
        if (result.status === 401) {
          this.internal.set({ status: 'unauthenticated' });
        } else {
          this.internal.set({
            status: 'indeterminate',
            issue: issueFromFailure(failure),
            ...(previousUser === undefined ? {} : { previousUser }),
          });
        }
        return;
      }
      if (!('data' in result)) {
        throw new ProtocolError('Session identity operation returned 304', {
          reason: 'unexpected-status',
          status: result.status,
          metadata: result.headers,
        });
      }
      let user: AuthUser;
      try {
        user = this.mapUser(result.data);
      } catch {
        throw new ProtocolError('Session identity response failed its user decoder', {
          reason: 'invalid-envelope',
          status: result.status,
          metadata: result.headers,
        });
      }
      this.assertCurrent(active);
      this.internal.set({ status: 'authenticated', user, idToken: null });
    } catch (error: unknown) {
      if (isAbort(error, active.controller.signal)) throw new OperationAbortedError();
      if (this.isCurrent(active)) {
        this.internal.set({
          status: 'indeterminate',
          issue: issueFromException(error),
          ...(previousUser === undefined ? {} : { previousUser }),
        });
      }
    } finally {
      this.end(active);
    }
  };

  async signIn(email: string, password: string): Promise<void> {
    const binding = this.operations.signIn;
    if (binding === undefined) throw new AuthCapabilityUnavailableError('password');
    await this.executeAction(binding, { email, password });
    await this.initialize();
  }

  async register(email: string, password: string): Promise<void> {
    const binding = this.operations.register;
    if (binding === undefined) throw new AuthCapabilityUnavailableError('password');
    await this.executeAction(binding, { email, password });
    await this.initialize();
  }

  async signOut(): Promise<void> {
    const binding = this.operations.signOut;
    if (binding === undefined) throw new AuthCapabilityUnavailableError('signOut');
    await this.executeAction(binding, undefined);
    this.internal.set({ status: 'unauthenticated' });
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    const binding = this.operations.refresh;
    if (binding === undefined) throw new AuthCapabilityUnavailableError('bearerToken');
    await this.executeAction(binding, undefined, signal);
  }

  private async refreshCredential(signal: AbortSignal): Promise<void> {
    // Policy refresh belongs to its requesting call rather than superseding it.
    const binding = this.operations.refresh;
    if (binding === undefined) throw new AuthCapabilityUnavailableError('bearerToken');
    const controller = new AbortController();
    this.refreshControllers.add(controller);
    const scope = createOperationCallScope([
      signal,
      this.active?.controller.signal,
      controller.signal,
    ]);
    try {
      scope.throwIfAborted();
      const result = await this.callBinding(binding, undefined, { signal: scope.signal });
      scope.throwIfAborted();
      if (!result.ok) throw new OperationApiError(result as OperationFailure<string>);
      if (!('data' in result)) {
        throw new ProtocolError('Session action returned 304', {
          reason: 'unexpected-status',
          status: result.status,
          metadata: result.headers,
        });
      }
    } finally {
      scope.cleanup();
      this.refreshControllers.delete(controller);
    }
  }

  /** Abort active identity/action work and prevent late results from updating state. */
  destroy(): void {
    for (const controller of this.refreshControllers) controller.abort();
    this.refreshControllers.clear();
    this.generation += 1;
    this.active?.controller.abort();
    this.active?.cleanup();
    this.active = undefined;
  }

  private async executeAction<TArguments>(
    binding: SessionAuthOperationBinding<TContract, TArguments>,
    arguments_: TArguments,
    signal?: AbortSignal
  ): Promise<void> {
    const active = this.begin(signal);
    try {
      const result = await this.callBinding(binding, arguments_, {
        signal: active.controller.signal,
      });
      this.assertCurrent(active);
      if (!result.ok) throw new OperationApiError(result as OperationFailure<string>);
      if (!('data' in result)) {
        throw new ProtocolError('Session action returned 304', {
          reason: 'unexpected-status',
          status: result.status,
          metadata: result.headers,
        });
      }
    } catch (error: unknown) {
      if (isAbort(error, active.controller.signal)) throw new OperationAbortedError();
      throw error;
    } finally {
      this.end(active);
    }
  }

  private callBinding<TArguments>(
    binding: SessionAuthOperationBinding<TContract, TArguments>,
    arguments_: TArguments,
    options: OperationCallOptions
  ): Promise<OperationResultOf<TContract, HttpOperationId<TContract>>> {
    type AnyCall = (
      operation: HttpOperationId<TContract>,
      input: InputOf<TContract, HttpOperationId<TContract>>,
      options: OperationCallOptions
    ) => Promise<OperationResultOf<TContract, HttpOperationId<TContract>>>;
    return (this.client.call as AnyCall)(binding.operation, binding.input(arguments_), options);
  }

  private begin(signal?: AbortSignal): ActiveAuthCall {
    for (const controller of this.refreshControllers) controller.abort();
    this.refreshControllers.clear();
    this.active?.controller.abort();
    this.active?.cleanup();
    this.generation += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const active = {
      generation: this.generation,
      controller,
      cleanup: () => signal?.removeEventListener('abort', abort),
    };
    this.active = active;
    return active;
  }

  private assertCurrent(active: ActiveAuthCall): void {
    if (!this.isCurrent(active) || active.controller.signal.aborted) {
      throw new OperationAbortedError();
    }
  }

  private isCurrent(active: ActiveAuthCall): boolean {
    return active.generation === this.generation;
  }

  private end(active: ActiveAuthCall): void {
    active.cleanup();
    if (this.isCurrent(active)) this.active = undefined;
  }
}

function currentUser(state: AuthState): AuthUser | undefined {
  if (state.status === 'authenticated') return state.user;
  return state.status === 'indeterminate' ? state.previousUser : undefined;
}

function issueFromFailure(failure: {
  readonly status: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly requestId?: string;
  };
  readonly headers: { readonly requestId?: string };
}): AuthStateIssue {
  const requestId = failure.error.requestId ?? failure.headers.requestId;
  return {
    kind: 'operation',
    message: failure.error.message,
    retryable: failure.status === 429 || failure.status >= 500,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function issueFromException(error: unknown): AuthStateIssue {
  if (error instanceof TransportError) {
    const requestId = error.metadata?.requestId;
    return {
      kind: 'transport',
      message: 'Unable to establish the current session',
      retryable: true,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
  if (error instanceof ProtocolError) {
    const requestId = error.metadata?.requestId;
    return {
      kind: 'protocol',
      message: 'The session response did not match its client contract',
      retryable: false,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
  return {
    kind: 'provider',
    message: 'The session provider could not establish identity',
    retryable: true,
  };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof OperationAbortedError;
}
