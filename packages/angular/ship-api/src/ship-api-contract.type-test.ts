import {
  createPolicyClient,
  type OperationClient,
  type OperationResultOf,
  type StreamOperationId,
} from '@sixthsummit/ship-angular/operations';
import {
  createShipApiClientExecutor,
  type ShipApiClientContractManifest,
  type ShipApiClientResult,
  type ShipApiOperationClient,
} from '@sixthsummit/ship-angular/ship-api';
import {
  createStream,
  type ShipStreamManifest,
  type StreamFrameOf,
  type StreamTerminalOf,
} from '@sixthsummit/ship-angular/stream';

interface ShipApiContract {
  readonly operations: {
    readonly 'accounts.read': {
      readonly transport: 'http';
      readonly input: { readonly params: { readonly accountId: string } };
      readonly result:
        | {
            readonly ok: true;
            readonly status: 200;
            readonly data: { readonly accountId: string; readonly name: string };
          }
        | {
            readonly ok: false;
            readonly status: 404;
            readonly error: {
              readonly code: 'ACCOUNT_NOT_FOUND';
              readonly message: string;
              readonly details: { readonly accountId: string };
            };
          };
    };
    readonly 'oauth.callback': {
      readonly transport: 'http';
      readonly input: { readonly query: { readonly code: string; readonly state: string } };
      readonly result: { readonly ok: true; readonly status: 302; readonly data: undefined };
    };
    readonly 'accounts.recalculate': {
      readonly transport: 'direct';
      readonly input: Record<never, never>;
      readonly result: {
        readonly ok: true;
        readonly status: 200;
        readonly data: { readonly accepted: true };
      };
    };
    readonly 'accounts.watch': {
      readonly transport: 'http';
      readonly input: { readonly params: { readonly accountId: string } };
      readonly stream: {
        readonly frame: { readonly accountId: string };
        readonly terminal: { readonly count: number };
      };
      readonly result: {
        readonly ok: true;
        readonly status: 200;
        readonly data: { readonly accepted: true };
      };
    };
  };
}

declare const rawClient: ShipApiOperationClient<ShipApiContract>;
declare const manifest: ShipApiClientContractManifest;
declare const streamManifest: ShipStreamManifest;

const executor = createShipApiClientExecutor<ShipApiContract>(manifest, ({ credentials }) => {
  credentials satisfies RequestCredentials;
  return rawClient;
});
const client: OperationClient<ShipApiContract> = createPolicyClient(executor, {
  policies: {
    'accounts.read': {
      authentication: 'anonymous',
      safety: 'safe',
      idempotency: 'unsupported',
      replayable: true,
    },
    'accounts.watch': {
      authentication: 'anonymous',
      safety: 'safe',
      idempotency: 'unsupported',
      replayable: true,
    },
    'oauth.callback': {
      authentication: 'anonymous',
      safety: 'safe',
      idempotency: 'unsupported',
      replayable: false,
    },
  },
});

async function narrowDeclaredRedirectResult(): Promise<void> {
  const redirect = await client.call('oauth.callback', {
    query: { code: 'code-1', state: 'state-1' },
  });
  if (redirect.ok && redirect.notModified !== true) {
    const status: 302 = redirect.status;
    const data: undefined = redirect.data;
    const location: string | undefined = redirect.headers.location;
    void status;
    void data;
    void location;
  }
}
void narrowDeclaredRedirectResult;

const streamOperation: StreamOperationId<ShipApiContract> = 'accounts.watch';
const streamFrame: StreamFrameOf<ShipApiContract, 'accounts.watch'> = {
  accountId: 'account-1',
};
const streamTerminal: StreamTerminalOf<ShipApiContract, 'accounts.watch'> = { count: 1 };
void streamOperation;
void streamFrame;
void streamTerminal;
createStream<ShipApiContract, 'accounts.watch'>({
  manifest: streamManifest,
  operation: 'accounts.watch',
  input: { params: { accountId: 'account-1' } },
  baseUrl: 'https://example.test',
});

const result: Promise<OperationResultOf<ShipApiContract, 'accounts.read'>> = client.call(
  'accounts.read',
  { params: { accountId: 'account-1' } }
);
void result;

// @ts-expect-error stable operation IDs remain exact
client.call('accounts.missing', {});

// @ts-expect-error input locations remain exact
client.call('accounts.read', { body: { accountId: 'account-1' } });

// @ts-expect-error backend-only direct operations are not remotely callable
client.call('accounts.recalculate', {});

// @ts-expect-error HTTP stream handles are not unary operation results
client.call('accounts.watch', { params: { accountId: 'account-1' } });

executor.call(
  // @ts-expect-error the ShipAPI unary executor also excludes HTTP stream IDs
  'accounts.watch',
  { params: { accountId: 'account-1' } },
  { signal: new AbortController().signal, attempt: 1 }
);

async function narrowCurrentShipApiResult(): Promise<void> {
  const response = await client.call('accounts.read', {
    params: { accountId: 'account-1' },
  });
  if (response.ok && response.notModified !== true) {
    const status: 200 = response.status;
    const name: string = response.data.name;
    void status;
    void name;
  } else if (!response.ok && response.error.declared && response.status === 404) {
    const code: 'ACCOUNT_NOT_FOUND' = response.error.code;
    void code;
  } else if (!response.ok && response.error.declared && response.status === 409) {
    const code: 'IDEMPOTENT_IN_FLIGHT' = response.error.code;
    void code;
  }
}

void narrowCurrentShipApiResult;

declare const structurallyCompatibleResult: ShipApiClientResult;
void structurallyCompatibleResult;
