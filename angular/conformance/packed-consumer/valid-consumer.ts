import { LegacyRestClientAdapter } from '@sixthsummit/ship-angular/legacy-rest';
import {
  createPolicyClient,
  type InputOf,
  type OperationClient,
  type OperationResultOf,
} from '@sixthsummit/ship-angular/operations';
import {
  createShipRealtime,
  type RealtimeManifest,
  type RealtimeSubscription,
  type ShipRealtimeTransport,
} from '@sixthsummit/ship-angular/realtime';
import { createShipApiClientExecutor } from '@sixthsummit/ship-angular/ship-api';
import {
  createStream,
  type ShipStreamManifest,
  type StreamFrameOf,
  type StreamTerminalOf,
} from '@sixthsummit/ship-angular/stream';
import { createFixtureClient } from '@sixthsummit/ship-api-conformance-client';
import {
  clientContract,
  contractMetadata,
  type FixtureChannels,
  type FixtureContract,
} from '@sixthsummit/ship-api-conformance-contract';

const generatedClient = createPolicyClient(
  createShipApiClientExecutor<FixtureContract>(clientContract, ({ credentials }) =>
    createFixtureClient({ credentials })
  ),
  {
    policies: {
      'accounts.get': policy('optional', 'safe'),
      'accounts.create': policy('required', 'unsafe', 'required'),
      'accounts.delete': policy('required', 'idempotent'),
      'public.status': policy('anonymous', 'safe'),
      'reports.download': policy('required', 'safe'),
      'assets.upload': policy('required', 'unsafe', 'required'),
      'events.watch': policy('optional', 'safe'),
      'agent.stream': policy('optional', 'safe'),
      'chat.socket': policy('required', 'safe'),
    },
    credentials: { kind: 'anonymous' },
  }
);
// The packed manifest is structurally a stream manifest, and the stream handle is
// typed from the contract rather than from hand-written generics.
const streamManifest: ShipStreamManifest = clientContract;
const agentStream = createStream<FixtureContract, 'agent.stream'>(
  {
    manifest: streamManifest,
    operation: 'agent.stream',
    input: { params: { agentId: 'agent-1' }, query: { mode: 'frames' } },
    baseUrl: 'https://api.example.test',
  },
  { platform: 'server' }
);
const streamFrame: StreamFrameOf<FixtureContract, 'agent.stream'> | undefined =
  agentStream.latest();
const streamTerminal: StreamTerminalOf<FixtureContract, 'agent.stream'> | undefined =
  agentStream.terminal();
const streamDelta: string | undefined = streamFrame?.delta;
const streamTokens: number | undefined = streamTerminal?.tokens;
const streamSeq: number = agentStream.seq();
void streamDelta;
void streamTokens;
void streamSeq;
void agentStream.frames();
void agentStream.error();
void agentStream.status();

declare const client: OperationClient<FixtureContract>;
const input: InputOf<FixtureContract, 'accounts.get'> = {
  params: { accountId: 'account-1' },
  query: { include: ['owner'] },
};

const result: OperationResultOf<FixtureContract, 'accounts.get'> = await client.call(
  'accounts.get',
  input
);

const generatedResult = await generatedClient.call('accounts.get', input);
if (generatedResult.ok && generatedResult.notModified !== true) {
  const generatedStatus: 200 = generatedResult.status;
  const generatedOwnerId: string | null = generatedResult.data.ownerId;
  void generatedStatus;
  void generatedOwnerId;
}

if (result.ok && result.notModified !== true) {
  const status: 200 = result.status;
  const ownerId: string | null = result.data.ownerId;
  void status;
  void ownerId;
}

const graphHash: `sha256:${string}` = contractMetadata.graphHash;
void graphHash;

// The manifest's `channels` projection types every subscription; `./realtime` never
// needs `socket.io-client` types to compile, which is what makes it an optional peer.
const realtimeManifest: RealtimeManifest<FixtureChannels> = clientContract;
declare const realtimeTransport: ShipRealtimeTransport;
const realtime = createShipRealtime<FixtureChannels>(
  {
    url: 'https://gateway.example',
    credential: () => 'token',
    manifest: realtimeManifest,
  },
  realtimeTransport
);
const room: RealtimeSubscription<FixtureChannels, 'room.messages'> = realtime.subscribe(
  'room.messages',
  'room-1'
);
const roomText: string | undefined = room.latest()?.text;
void roomText;
const roomMembers: readonly string[] | undefined = room.presence()?.members;
void roomMembers;
const audit = realtime.subscribe('tenant.audit', 'tenant-1');
// @ts-expect-error tenant.audit declares presence: false
void audit.presence;

const legacyClient = new LegacyRestClientAdapter<FixtureContract>({
  'accounts.get': {
    invoke: async () => Response.json({ id: 'account-1', ownerId: null }),
    declaredErrors: ['ACCOUNT_NOT_FOUND'],
    successStatuses: [200],
    decodeSuccess: value => decodeLegacyAccount(value),
    cancellation: 'forwarded',
  },
});
legacyClient.compatibility('accounts.get') satisfies {
  readonly mapped: boolean;
  readonly cancellation?: 'forwarded' | 'discard-only';
};

export { generatedClient };

function decodeLegacyAccount(value: unknown): {
  readonly id: string;
  readonly ownerId: string | null;
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('ownerId' in value) ||
    (value.ownerId !== null && typeof value.ownerId !== 'string')
  ) {
    throw new TypeError('Invalid legacy account response');
  }
  return { id: value.id, ownerId: value.ownerId };
}

function policy(
  authentication: 'anonymous' | 'optional' | 'required',
  safety: 'safe' | 'idempotent' | 'unsafe',
  idempotency: 'unsupported' | 'supported' | 'required' = 'unsupported'
) {
  return { authentication, safety, idempotency, replayable: true } as const;
}
