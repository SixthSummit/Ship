import '@angular/compiler';
import { LegacyRestClientAdapter } from '@sixthsummit/ship-angular/legacy-rest';
import { createPolicyClient } from '@sixthsummit/ship-angular/operations';
import { createShipRealtime } from '@sixthsummit/ship-angular/realtime';
import { createShipApiClientExecutor } from '@sixthsummit/ship-angular/ship-api';
import { createStream } from '@sixthsummit/ship-angular/stream';
import { assertOperationClientConformance } from '@sixthsummit/ship-angular/testing';
import { createFixtureClient } from '@sixthsummit/ship-api-conformance-client';
import { clientContract, contractMetadata } from '@sixthsummit/ship-api-conformance-contract';

const policies = Object.fromEntries(
  Object.entries(contractMetadata.operations).map(([operation, definition]) => [
    operation,
    {
      authentication: operation === 'public.status' ? 'anonymous' : 'optional',
      safety: operation === 'accounts.create' ? 'unsafe' : 'safe',
      idempotency: 'unsupported',
      replayable: true,
      transport: definition.transport,
    },
  ])
);
const executor = createShipApiClientExecutor(clientContract, ({ credentials }) =>
  createFixtureClient({ credentials })
);
const client = createPolicyClient(executor, {
  policies,
  credentials: { kind: 'anonymous' },
});
const unloadedLegacyClient = new LegacyRestClientAdapter({});
if (unloadedLegacyClient.compatibility('accounts.get').mapped) {
  throw new Error('An empty legacy REST adapter reported a mapped operation');
}
const report = await assertOperationClientConformance(client, {
  calls: [
    {
      operation: 'accounts.get',
      input: { params: { accountId: 'account-1' } },
      expect: { kind: 'success', status: 200, requestId: 'request-account-get' },
    },
    {
      operation: 'accounts.create',
      input: { body: { name: 'Ada' } },
      expect: { kind: 'success', status: 201, requestId: 'request-account-create' },
    },
    {
      operation: 'accounts.delete',
      input: { params: { accountId: 'account-1' } },
      expect: { kind: 'success', status: 204, requestId: 'request-account-delete' },
    },
    {
      operation: 'accounts.get',
      input: { params: { accountId: 'missing' } },
      expect: {
        kind: 'failure',
        status: 404,
        code: 'ACCOUNT_NOT_FOUND',
        requestId: 'request-account-missing',
      },
    },
  ],
  cancellation: {
    operation: 'public.status',
    input: { query: { delayMs: 1000 } },
  },
});

// SSR proof: in a server runtime the packed stream client renders its initial handle
// and opens no request. `fetch` here would throw if it were ever called.
let streamFetchCalls = 0;
const serverRenderedStream = createStream(
  {
    manifest: clientContract,
    operation: 'agent.stream',
    input: { params: { agentId: 'agent-1' } },
    baseUrl: 'https://api.example.test',
  },
  {
    fetch: () => {
      streamFetchCalls += 1;
      throw new Error('SSR must not open a stream request');
    },
  }
);
await new Promise(resolve => setTimeout(resolve, 10));
if (
  serverRenderedStream.status() !== 'idle' ||
  serverRenderedStream.frames().length !== 0 ||
  serverRenderedStream.terminal() !== undefined ||
  serverRenderedStream.error() !== undefined ||
  serverRenderedStream.seq() !== 0 ||
  streamFetchCalls !== 0
) {
  throw new Error('The packed stream client opened a request during server rendering');
}

if (contractMetadata.fixtureProtocolVersion !== 1) {
  throw new Error('Unexpected fixture protocol version');
}
if (!contractMetadata.graphHash.startsWith('sha256:')) {
  throw new Error('Contract graph hash is unavailable');
}
if (report.calls !== 4 || !report.cancellation) {
  throw new Error(`Unexpected conformance report: ${JSON.stringify(report)}`);
}

// The ./realtime entry must load and subscribe without `socket.io-client` installed:
// the Socket.IO adapter is imported lazily and only when it is the chosen transport.
const realtimeFrames = [];
const realtime = createShipRealtime(
  {
    url: 'https://gateway.invalid',
    credential: () => 'packed-conformance-token',
    manifest: clientContract,
  },
  async request => ({
    subscribe: async () => {
      setTimeout(
        () =>
          request.handlers.onEvent({
            channel: 'room.messages',
            scopeKey: 'room-1',
            seq: 1,
            publishedAt: '2026-09-18T00:00:00.000Z',
            payload: { roomId: 'room-1', text: 'packed' },
          }),
        0
      );
      return { ok: true, subscriptionId: 'packed-subscription' };
    },
    unsubscribe: async () => ({ ok: true }),
    presenceSnapshot: async () => ({ ok: true, count: 1, members: ['actor-1'] }),
    close: () => undefined,
  })
);
const packedRoom = realtime.subscribe('room.messages', 'room-1');
packedRoom.events(event => realtimeFrames.push(event.seq));
await new Promise(resolve => setTimeout(resolve, 20));
if (packedRoom.status() !== 'active' || packedRoom.latest()?.text !== 'packed') {
  throw new Error('The packed realtime entry did not deliver a declared payload');
}
if (packedRoom.presence()?.count !== 1) {
  throw new Error('The packed realtime entry did not expose presence');
}
const packedRealtimeStatus = packedRoom.status();
realtime.close();

console.log(
  JSON.stringify({
    fixtureProtocolVersion: contractMetadata.fixtureProtocolVersion,
    graphHash: contractMetadata.graphHash,
    report: {
      ...report,
      realtime: { frames: realtimeFrames, status: packedRealtimeStatus },
      serverRenderedStreamStatus: serverRenderedStream.status(),
    },
  })
);
