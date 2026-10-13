import '@angular/compiler';
import { Injector, PLATFORM_ID, runInInjectionContext, type StaticProvider } from '@angular/core';
import { createOperationDownload } from '@sixthsummit/ship-angular/download';
import {
  createOperationRequestPolicy,
  type HttpOperationId,
  type InputOf,
  type OperationClient,
  type OperationPolicyMap,
  type OperationResultOf,
  type OperationTypeContract,
} from '@sixthsummit/ship-angular/operations';
import {
  createShipRealtime,
  createSocketIoTransport,
  injectRealtime,
  provideShipRealtime,
  type RealtimeManifest,
} from '@sixthsummit/ship-angular/realtime';
import { createOperationSocket } from '@sixthsummit/ship-angular/socket';
import {
  createOperationStream,
  createStream,
  type ShipStreamHandle,
  type ShipStreamManifest,
  type ShipStreamStatus,
} from '@sixthsummit/ship-angular/stream';
import { createOperationUpload } from '@sixthsummit/ship-angular/upload';

declare const __SHIP_FIXTURE_ORIGIN__: string;
declare const __SHIP_FIXTURE_WS_ORIGIN__: string;
declare const __SHIP_REALTIME_ORIGIN__: string;

declare global {
  interface Window {
    __SHIP_BROWSER_DONE__?: boolean;
    __SHIP_BROWSER_ERROR__?: { readonly name: string; readonly message: string };
    __SHIP_BROWSER_REPORT__?: BrowserReport;
  }
}

type UploadMode = 'success' | 'reject' | 'slow';

interface BrowserContract extends OperationTypeContract {
  readonly operations: {
    readonly 'assets.upload': {
      readonly transport: 'upload';
      readonly input: { readonly body: { readonly file: File; readonly mode: UploadMode } };
      readonly result:
        | {
            readonly ok: true;
            readonly status: 201;
            readonly data: { readonly assetId: string; readonly receivedBytes: number };
          }
        | {
            readonly ok: false;
            readonly status: 422;
            readonly error: { readonly code: 'UPLOAD_REJECTED' };
          };
    };
    readonly 'reports.download': {
      readonly transport: 'download';
      readonly input: { readonly params: { readonly reportId: 'ok' | 'missing' | 'slow' } };
      readonly result:
        | { readonly ok: true; readonly status: 200; readonly data: Blob }
        | {
            readonly ok: false;
            readonly status: 404;
            readonly error: { readonly code: 'REPORT_NOT_FOUND' };
          };
    };
    readonly 'events.watch': {
      readonly transport: 'stream';
      readonly input: { readonly query: { readonly mode: 'normal' | 'slow' } };
      readonly result: {
        readonly ok: true;
        readonly status: 200;
        readonly data: { readonly value: number };
      };
    };
    readonly 'agent.stream': {
      readonly transport: 'stream';
      readonly input: {
        readonly params: { readonly agentId: string };
        readonly query: {
          readonly mode:
            | 'frames'
            | 'error-after-frame'
            | 'error-before-frame'
            | 'open'
            | 'terminal-only';
        };
      };
      readonly result:
        | {
            readonly ok: true;
            readonly status: 200;
            readonly data: {
              readonly frame: { readonly delta: string };
              readonly terminal: { readonly tokens: number };
            };
          }
        | {
            readonly ok: false;
            readonly status: 404;
            readonly error: { readonly code: 'AGENT_NOT_FOUND' };
          };
    };
    readonly 'chat.ticket': {
      readonly transport: 'http';
      readonly input: { readonly params: { readonly roomId: string } };
      readonly result: {
        readonly ok: true;
        readonly status: 200;
        readonly data: { readonly ticket: string };
      };
    };
    readonly 'chat.socket': {
      readonly transport: 'socket';
      readonly input: { readonly params: { readonly roomId: string } };
      readonly result: {
        readonly ok: true;
        readonly status: 101;
        readonly data:
          | { readonly kind: 'connected'; readonly connection: number }
          | { readonly kind: 'echo'; readonly value: string };
      };
    };
  };
}

interface BrowserReport {
  readonly cookieEstablished: boolean;
  readonly upload: {
    readonly status: string;
    readonly observedProgress: number;
    readonly requestId?: string;
    readonly failureCode?: string;
    readonly cancellation: string;
  };
  readonly download: {
    readonly bytes: readonly number[];
    readonly filename?: string;
    readonly requestId?: string;
    readonly etag?: string;
    readonly failureCode?: string;
    readonly cancellation: string;
    readonly redirect: string;
  };
  readonly stream: {
    readonly values: readonly number[];
    readonly lastEventId?: string;
    readonly requestId?: string;
    readonly cancellation: string;
  };
  readonly wireStream: {
    readonly deltas: readonly string[];
    readonly terminalTokens?: number;
    readonly seq: number;
    readonly statusTransitions: readonly string[];
    readonly errorAfterFrame: { readonly code: string; readonly status: number };
    readonly errorAfterFrameDeltas: readonly string[];
    readonly errorBeforeFrame: { readonly code: string; readonly status: number };
    readonly errorBeforeFrameStatus: string;
    readonly abortStatus: string;
    readonly terminalOnlyFrames: number;
    readonly terminalOnlyStatus: string;
    readonly terminalOnlyTerminal: string;
  };
  readonly socket: {
    readonly protocolCloseCodes: readonly number[];
    readonly ticketCalls: number;
    readonly status: string;
    readonly sendQueued: boolean;
    readonly messages: readonly string[];
  };
  readonly realtime: BrowserRealtimeReport;
  readonly metrics: BrowserFixtureMetrics;
}

interface BrowserRealtimeReport {
  readonly status: string;
  readonly payload?: { readonly roomId: string; readonly text: string };
  readonly seq?: number;
  readonly presenceCount?: number;
  readonly presenceMembers: readonly string[];
  readonly dropped: number;
  readonly forbiddenStatus: string;
  readonly forbiddenCode?: string;
  readonly invalidScopeCode?: string;
  readonly ssrStatus: string;
}

/** The realtime projection the synthetic ShipAPI fixture manifest declares. */
interface RealtimeChannels {
  readonly channels: {
    readonly 'account.updated': {
      readonly scope: 'actor';
      readonly payload: { readonly accountId: string };
      readonly presence: false;
    };
    readonly 'room.messages': {
      readonly scope: 'resource';
      readonly payload: { readonly roomId: string; readonly text: string };
      readonly presence: true;
    };
    readonly 'tenant.audit': {
      readonly scope: 'tenant';
      readonly payload: { readonly entry: string };
      readonly presence: false;
    };
  };
}

const realtimeManifest: RealtimeManifest<RealtimeChannels> = {
  channels: {
    'account.updated': { scope: 'actor', payload: 'AccountUpdated', presence: false },
    'room.messages': { scope: 'resource', payload: 'RoomMessage', presence: true },
    'tenant.audit': { scope: 'tenant', payload: 'TenantAuditEntry', presence: false },
  },
  operations: { 'rooms.post': { publishes: ['room.messages'] } },
};

interface BrowserFixtureMetrics {
  readonly requests: readonly {
    readonly path: string;
    readonly origin?: string;
    readonly cookie?: string;
    readonly authorization?: string;
    readonly csrf?: string;
    readonly requestId?: string;
    readonly idempotencyKey?: string;
    readonly contentType?: string;
  }[];
  readonly uploadAborted: boolean;
  readonly slowDownloadClosed: boolean;
  readonly slowStreamClosed: boolean;
  readonly wireStreamAborted: boolean;
  readonly socketConnections: readonly {
    readonly connection: number;
    readonly origin?: string;
    readonly protocol: string;
    readonly ticket: string | null;
  }[];
  readonly socketMessages: readonly string[];
  readonly socketClientCloses: readonly { path: string; code: number }[];
}

const policies: OperationPolicyMap<BrowserContract> = {
  'assets.upload': {
    authentication: 'required',
    safety: 'unsafe',
    idempotency: 'supported',
    replayable: true,
    csrf: true,
  },
  'reports.download': {
    authentication: 'required',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
  'events.watch': {
    authentication: 'required',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
  'agent.stream': {
    authentication: 'required',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
  'chat.ticket': {
    authentication: 'required',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
  'chat.socket': {
    authentication: 'required',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
  },
};

let stage = 'startup';

void run().then(
  report => {
    window.__SHIP_BROWSER_REPORT__ = report;
    window.__SHIP_BROWSER_DONE__ = true;
    setStatus('passed');
  },
  (error: unknown) => {
    window.__SHIP_BROWSER_ERROR__ = {
      name: errorName(error),
      message: `${stage}: ${errorMessage(error)}`,
    };
    window.__SHIP_BROWSER_DONE__ = true;
    setStatus('failed');
  }
);

async function run(): Promise<BrowserReport> {
  stage = 'cookie';
  const session = await fetch(`${__SHIP_FIXTURE_ORIGIN__}/session/set`, {
    credentials: 'include',
  });
  assert(session.ok, 'The cross-origin fixture cookie could not be established');

  let requestSequence = 0;
  const requestPolicy = createOperationRequestPolicy<BrowserContract>({
    policies,
    credentials: {
      kind: 'cookie',
      credentials: 'include',
      getCsrfToken: async () => 'browser-csrf',
    },
    requestId: { generate: () => `browser-request-${(requestSequence += 1)}` },
    allowedOrigins: [__SHIP_FIXTURE_ORIGIN__],
  });

  stage = 'upload';
  const upload = await runUpload(requestPolicy);
  stage = 'download';
  const download = await runDownload(requestPolicy);
  stage = 'stream';
  const stream = await runStream(requestPolicy);
  stage = 'wire-stream';
  const wireStream = await runWireStream();
  stage = 'socket';
  const socket = await runSocket();
  stage = 'realtime';
  const realtime = await runRealtime();
  stage = 'server-abort-observation';
  let latestMetrics: BrowserFixtureMetrics | undefined;
  try {
    await waitUntil(async () => {
      latestMetrics = await readMetrics();
      return (
        latestMetrics.uploadAborted &&
        latestMetrics.slowDownloadClosed &&
        latestMetrics.slowStreamClosed &&
        latestMetrics.wireStreamAborted
      );
    }, 'server abort observation');
  } catch {
    throw new Error(`Server abort metrics: ${JSON.stringify(latestMetrics)}`);
  }
  const metrics = await readMetrics();

  return {
    cookieEstablished: true,
    upload,
    download,
    stream,
    wireStream,
    socket,
    realtime,
    metrics,
  };
}

async function runRealtime(): Promise<BrowserRealtimeReport> {
  let issued = 0;
  const client = createShipRealtime<RealtimeChannels>(
    {
      url: __SHIP_REALTIME_ORIGIN__,
      credential: () => `browser-realtime-token-${(issued += 1)}`,
      manifest: realtimeManifest,
    },
    createSocketIoTransport()
  );

  const room = client.subscribe('room.messages', 'room-1');
  const frames: number[] = [];
  room.events(event => frames.push(event.seq));
  await waitUntil(() => room.status() !== 'pending', 'realtime subscription ack');
  await waitUntil(() => room.latest() !== undefined, 'realtime event delivery');
  await waitUntil(() => (room.presence()?.members.length ?? 0) >= 2, 'realtime presence');
  await waitUntil(() => room.dropped() > 0, 'realtime drop notice');

  const forbidden = client.subscribe('tenant.audit', 'tenant-1');
  await waitUntil(() => forbidden.status() !== 'pending', 'forbidden subscription ack');

  const invalidScope = client.subscribe('account.updated', 'someone-else');
  await waitUntil(() => invalidScope.status() !== 'pending', 'invalid scope ack');

  // An SSR render must never open a socket: the fixture's connection count is asserted.
  const serverInjector = Injector.create({
    providers: [
      { provide: PLATFORM_ID, useValue: 'server' },
      provideShipRealtime<RealtimeChannels>({
        url: __SHIP_REALTIME_ORIGIN__,
        credential: () => 'browser-realtime-token-ssr',
        manifest: realtimeManifest,
      }) as StaticProvider,
    ],
  });
  const serverClient = runInInjectionContext(serverInjector, () =>
    injectRealtime<RealtimeChannels>()
  );
  const ssrSubscription = serverClient.subscribe('room.messages', 'room-1');
  await new Promise(resolve => setTimeout(resolve, 50));

  const payload = room.latest();
  const presence = room.presence();
  const seq = frames[0];
  const forbiddenCode = forbidden.error();
  const invalidScopeCode = invalidScope.error();
  const report: BrowserRealtimeReport = {
    status: room.status(),
    ...(payload === undefined ? {} : { payload }),
    ...(seq === undefined ? {} : { seq }),
    ...(presence === undefined ? {} : { presenceCount: presence.count }),
    presenceMembers: [...(presence?.members ?? [])],
    dropped: room.dropped(),
    forbiddenStatus: forbidden.status(),
    ...(forbiddenCode === undefined ? {} : { forbiddenCode }),
    ...(invalidScopeCode === undefined ? {} : { invalidScopeCode }),
    ssrStatus: ssrSubscription.status(),
  };

  // `room` is the last live subscription: releasing it waits for the `ship:unsubscribe` ack
  // before the idle link is closed, so the gateway records the final unsubscribe.
  room.unsubscribe();
  await waitUntil(
    async () => (await readRealtimeMetrics()).unsubscribes.length === 1,
    'gateway unsubscribe observation'
  );
  client.close();
  return report;
}

async function runUpload(
  policy: ReturnType<typeof createOperationRequestPolicy<BrowserContract>>
): Promise<BrowserReport['upload']> {
  const upload = createOperationUpload(
    policy,
    'assets.upload',
    {
      request: ({ body }) => {
        const form = new FormData();
        form.append('asset', body.file);
        return {
          url: `${__SHIP_FIXTURE_ORIGIN__}/upload${body.mode === 'success' ? '' : `/${body.mode}`}`,
          body: form,
          files: [{ field: 'asset', file: body.file }],
        };
      },
      successStatuses: [201],
      declaredErrors: ['UPLOAD_REJECTED'],
      fields: [
        {
          field: 'asset',
          minimumCount: 1,
          maximumCount: 1,
          maximumBytes: 12 * 1024 * 1024,
          acceptedMediaTypes: ['application/octet-stream'],
        },
      ],
      decodeSuccess: response => decodeUploadSuccess(response.bodyText),
    },
    {}
  );
  const file = new File([new Uint8Array(4 * 1024 * 1024)], 'browser.bin', {
    type: 'application/octet-stream',
  });
  const pending = upload.start(
    { body: { file, mode: 'success' } },
    { idempotencyKey: 'browser-upload-key' }
  );
  await waitUntil(
    () => upload.progress() > 0 || !upload.pending(),
    'upload progress or completion'
  );
  const result = await pending;
  assert(result.ok, 'The browser upload did not succeed');
  assert(result.status === 201, 'The browser upload status drifted');
  assert(result.data.assetId === 'asset-browser', 'The browser upload decoder lost its body');
  const observedProgress = upload.progress();

  const rejection = await upload.start(
    { body: { file, mode: 'reject' } },
    { idempotencyKey: 'browser-upload-reject' }
  );
  assert(!rejection.ok, 'The rejected browser upload was reported as successful');

  const canceled = upload.start(
    { body: { file, mode: 'slow' } },
    { idempotencyKey: 'browser-upload-cancel' }
  );
  await waitUntil(
    async () => (await readMetrics()).requests.some(request => request.path === '/upload/slow'),
    'slow upload request'
  );
  assert(upload.cancel(), 'The browser upload did not expose an active cancellation');
  const cancellation = await rejectedName(canceled);

  return {
    status: 'complete',
    observedProgress,
    ...(result.headers.requestId === undefined ? {} : { requestId: result.headers.requestId }),
    failureCode: rejection.error.code,
    cancellation,
  };
}

async function runDownload(
  policy: ReturnType<typeof createOperationRequestPolicy<BrowserContract>>
): Promise<BrowserReport['download']> {
  const download = createOperationDownload(
    policy,
    'reports.download',
    {
      request: ({ params }) => ({
        url: `${__SHIP_FIXTURE_ORIGIN__}/download${
          params.reportId === 'ok' ? '' : `/${params.reportId === 'missing' ? 'error' : 'slow'}`
        }`,
      }),
      successStatuses: [200],
      declaredErrors: ['REPORT_NOT_FOUND'],
      contentTypes: ['application/pdf'],
    },
    { representation: 'arrayBuffer' }
  );

  const result = await download.start({ params: { reportId: 'ok' } });
  assert(result.ok, 'The browser download did not succeed');
  const bytes = [...new Uint8Array(result.data)];
  const failure = await download.start({ params: { reportId: 'missing' } });
  assert(!failure.ok, 'The JSON download error was parsed as binary success');

  const canceled = download.start({ params: { reportId: 'slow' } });
  await waitUntil(
    async () => (await readMetrics()).requests.some(request => request.path === '/download/slow'),
    'slow download request'
  );
  download.cancel();
  const cancellation = await rejectedName(canceled);

  const blobDownload = createOperationDownload(
    policy,
    'reports.download',
    {
      request: () => ({ url: `${__SHIP_FIXTURE_ORIGIN__}/download` }),
      successStatuses: [200],
      declaredErrors: ['REPORT_NOT_FOUND'],
    },
    { representation: 'blob' }
  );
  const blobResult = await blobDownload.start({ params: { reportId: 'ok' } });
  assert(
    blobResult.ok && blobResult.data instanceof Blob,
    'Browser download did not return a native Blob'
  );
  assert(
    blobResult.data.size === 6 && blobResult.data.type === 'application/pdf',
    'Browser Blob metadata changed'
  );
  assert(
    [...new Uint8Array(await blobResult.data.arrayBuffer())].join(',') === bytes.join(','),
    'Browser Blob bytes changed'
  );
  const redirectDownload = createOperationDownload(
    createOperationRequestPolicy<BrowserContract>({
      policies,
      allowedOrigins: [__SHIP_FIXTURE_ORIGIN__],
      credentials: {
        kind: 'bearer',
        headerName: 'x-ship-token',
        getToken: async () => 'browser-secret',
      },
    }),
    'reports.download',
    {
      request: () => ({ url: `${__SHIP_FIXTURE_ORIGIN__}/download/redirect` }),
      successStatuses: [200],
      declaredErrors: ['REPORT_NOT_FOUND'],
    },
    { representation: 'blob' }
  );
  const redirect = await rejectedName(redirectDownload.start({ params: { reportId: 'ok' } }));
  assert(redirect === 'TransportError', 'Download followed an unapproved redirect');
  return {
    redirect,
    bytes,
    ...(result.filename === undefined ? {} : { filename: result.filename }),
    ...(result.headers.requestId === undefined ? {} : { requestId: result.headers.requestId }),
    ...(result.headers.etag === undefined ? {} : { etag: result.headers.etag }),
    failureCode: failure.error.code,
    cancellation,
  };
}

async function runStream(
  policy: ReturnType<typeof createOperationRequestPolicy<BrowserContract>>
): Promise<BrowserReport['stream']> {
  const stream = createOperationStream(policy, 'events.watch', {
    request: ({ query }) => ({
      url: `${__SHIP_FIXTURE_ORIGIN__}/stream${query.mode === 'slow' ? '/slow' : ''}`,
    }),
    successStatuses: [200],
    declaredErrors: [],
    contentTypes: ['text/event-stream'],
    decode: frame => decodeStreamEvent(frame.data),
  });

  const terminal = await stream.start({ query: { mode: 'normal' } });
  assert(terminal.kind === 'closed', 'The finite browser stream did not close normally');
  const values = stream.events().map(event => event.value);
  const lastEventId = stream.lastEventId();
  const requestId = stream.headers()?.requestId;

  const canceled = stream.start({ query: { mode: 'slow' } });
  await waitUntil(() => stream.events().length === 1, 'slow stream event');
  stream.cancel();
  const cancellation = await rejectedName(canceled);

  return {
    values,
    ...(lastEventId === undefined ? {} : { lastEventId }),
    ...(requestId === undefined ? {} : { requestId }),
    cancellation,
  };
}

const streamManifest: ShipStreamManifest = {
  schemaVersion: 1,
  appId: 'ship-angular-browser-conformance',
  fingerprint: `sha256:${'b'.repeat(64)}`,
  operations: [
    {
      id: 'agent.stream',
      method: 'GET',
      path: '/wire-stream',
      success: [{ status: 200 }],
      errors: [{ code: 'AGENT_NOT_FOUND', status: 404 }],
      response: {
        mode: 'stream',
        framing: 'sse',
        frame: { $ref: '#/schemas/AgentDelta' },
        terminal: { $ref: '#/schemas/AgentUsage' },
        limits: { heartbeatMs: 250, maxDurationMs: 10_000, maxFrames: 64 },
      },
    },
  ],
};

let wireStreamRequests = 0;

function openWireStream(
  mode: 'frames' | 'error-after-frame' | 'error-before-frame' | 'open' | 'terminal-only'
): ShipStreamHandle<{ readonly delta: string }, { readonly tokens: number }> {
  wireStreamRequests += 1;
  return createStream<BrowserContract, 'agent.stream'>(
    {
      manifest: streamManifest,
      operation: 'agent.stream',
      input: { params: { agentId: 'agent-1' }, query: { mode } },
      baseUrl: __SHIP_FIXTURE_ORIGIN__,
    },
    {
      credentials: 'include',
      headers: { 'x-request-id': `browser-request-stream-${wireStreamRequests}` },
    }
  );
}

/**
 * Sample the status signal until it reaches `terminal`, so the observed lifecycle can be
 * asserted, not inferred. One sampler both records and decides, so the terminal state is
 * always the last recorded transition; a separate poller could stop it first.
 */
async function observeStatusUntil(
  handle: { readonly status: () => ShipStreamStatus },
  terminal: ShipStreamStatus,
  label: string,
  timeoutMs = 5_000
): Promise<string[]> {
  const transitions: string[] = [handle.status()];
  const deadline = performance.now() + timeoutMs;
  while (transitions[transitions.length - 1] !== terminal) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 1));
    const current = handle.status();
    if (transitions[transitions.length - 1] !== current) transitions.push(current);
  }
  return transitions;
}

async function runWireStream(): Promise<BrowserReport['wireStream']> {
  const normal = openWireStream('frames');
  const statusTransitions = await observeStatusUntil(normal, 'closed', 'wire stream terminal');
  assert(normal.error() === undefined, 'A completed wire stream reported an error');

  const afterFrame = openWireStream('error-after-frame');
  await waitUntil(() => afterFrame.status() === 'error', 'wire stream error event');
  const afterFrameError = afterFrame.error();
  assert(afterFrameError !== undefined, 'The wire error event was not surfaced');

  const beforeFrame = openWireStream('error-before-frame');
  await waitUntil(() => beforeFrame.status() === 'error', 'wire stream error envelope');
  const beforeFrameError = beforeFrame.error();
  assert(beforeFrameError !== undefined, 'The pre-first-frame error envelope was not surfaced');
  assert(beforeFrame.frames().length === 0, 'A pre-first-frame failure produced frames');

  const terminalOnly = openWireStream('terminal-only');
  await waitUntil(() => terminalOnly.status() === 'closed', 'terminal-only wire stream');
  assert(terminalOnly.error() === undefined, 'A terminal-only stream reported an error');

  const aborted = openWireStream('open');
  await waitUntil(() => aborted.frames().length === 1, 'wire stream first frame');
  aborted.abort();
  await waitUntil(() => aborted.status() === 'aborted', 'wire stream abort');

  const terminalTokens = normal.terminal()?.tokens;
  return {
    deltas: normal.frames().map(frame => frame.delta),
    ...(terminalTokens === undefined ? {} : { terminalTokens }),
    seq: normal.seq(),
    statusTransitions,
    errorAfterFrame: { code: afterFrameError.code, status: afterFrameError.status },
    errorAfterFrameDeltas: afterFrame.frames().map(frame => frame.delta),
    errorBeforeFrame: { code: beforeFrameError.code, status: beforeFrameError.status },
    errorBeforeFrameStatus: beforeFrame.status(),
    abortStatus: aborted.status(),
    terminalOnlyFrames: terminalOnly.frames().length,
    terminalOnlyStatus: terminalOnly.status(),
    terminalOnlyTerminal: String(terminalOnly.terminal()),
  };
}

async function runSocket(): Promise<BrowserReport['socket']> {
  let ticketCalls = 0;
  const ticketClient: OperationClient<BrowserContract> = {
    async call<TId extends HttpOperationId<BrowserContract>>(
      operation: TId,
      _input: InputOf<BrowserContract, TId>
    ): Promise<OperationResultOf<BrowserContract, TId>> {
      if (operation !== 'chat.ticket') throw new Error(`Unexpected operation: ${operation}`);
      ticketCalls += 1;
      const result = {
        ok: true,
        status: 200 as const,
        data: { ticket: `browser-ticket-${ticketCalls}` },
        headers: { headers: {}, requestId: `ticket-request-${ticketCalls}` },
      };
      return result as OperationResultOf<BrowserContract, TId>;
    },
  };
  const socket = createOperationSocket<
    BrowserContract,
    'chat.socket',
    { readonly action: 'ping' },
    'chat.ticket'
  >(
    ticketClient,
    {
      ticket: {
        operation: 'chat.ticket',
        input: input => ({ params: { roomId: input.params.roomId } }),
      },
      connection: (input, ticket) => ({
        url: `${__SHIP_FIXTURE_WS_ORIGIN__}/socket?room=${encodeURIComponent(
          input.params.roomId
        )}&ticket=${encodeURIComponent(ticket.ticket)}`,
        protocols: ['ship.v1'],
      }),
      decode: event => decodeSocketMessage(event.data),
      encode: message => JSON.stringify(message),
      cleanCloseCodes: [1000],
      reconnectCloseCodes: [4001],
      reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      requireProtocol: true,
    },
    {
      allowedSocketOrigins: [__SHIP_FIXTURE_WS_ORIGIN__],
      maxMessages: 8,
      maxQueuedSends: 2,
      sendWhileConnecting: 'queue',
    }
  );

  const connected = await socket.connect({ params: { roomId: 'browser-room' } });
  assert(connected.ok, 'The browser socket could not start connecting');
  await waitUntil(() => ticketCalls === 2 && socket.status() === 'open', 'socket reconnect');
  const send = socket.send({ action: 'ping' });
  assert(send.ok, 'The browser socket rejected an open send');
  await waitUntil(() => socket.messages().some(message => message.kind === 'echo'), 'socket echo');
  const messages = socket
    .messages()
    .map(message =>
      message.kind === 'connected' ? `connected:${message.connection}` : `echo:${message.value}`
    );
  socket.close(1000, 'browser complete');
  await waitUntil(() => socket.status() === 'closed', 'socket close');

  const protocolCloseCodes: number[] = [];
  for (const mode of ['invalid', 'no-protocol']) {
    const invalid = createOperationSocket<
      BrowserContract,
      'chat.socket',
      { readonly action: 'ping' }
    >(
      ticketClient,
      {
        connection: () => ({
          url: `${__SHIP_FIXTURE_WS_ORIGIN__}/socket/${mode}`,
          protocols: mode === 'no-protocol' ? [] : ['ship.v1'],
        }),
        decode: event => decodeSocketMessage(event.data),
        encode: message => JSON.stringify(message),
        cleanCloseCodes: [1000],
        reconnectCloseCodes: [],
        requireProtocol: true,
      },
      { allowedSocketOrigins: [__SHIP_FIXTURE_WS_ORIGIN__] }
    );
    await invalid.connect({ params: { roomId: 'browser-room' } });
    await waitUntil(() => invalid.status() === 'closed', `socket ${mode} protocol closure`);
    assert(invalid.error()?.name === 'ProtocolError', 'Protocol error was not retained');
    assert(!invalid.send({ action: 'ping' }).ok, 'Protocol-failed socket allowed a send');
    const closed = (await readMetrics()).socketClientCloses.find(
      value => value.path === `/socket/${mode}`
    );
    assert(closed?.code === 4002, 'The browser did not send the protocol error close frame');
    protocolCloseCodes.push(closed.code);
  }
  return {
    protocolCloseCodes,
    ticketCalls,
    status: socket.status(),
    sendQueued: send.queued,
    messages,
  };
}

function decodeUploadSuccess(bodyText: string): {
  readonly assetId: string;
  readonly receivedBytes: number;
} {
  const value: unknown = JSON.parse(bodyText);
  if (
    !isRecord(value) ||
    typeof value['assetId'] !== 'string' ||
    typeof value['receivedBytes'] !== 'number'
  ) {
    throw new TypeError('Invalid upload response');
  }
  return { assetId: value['assetId'], receivedBytes: value['receivedBytes'] };
}

function decodeStreamEvent(data: string): { readonly value: number } {
  const value: unknown = JSON.parse(data);
  if (!isRecord(value) || typeof value['value'] !== 'number') {
    throw new TypeError('Invalid stream event');
  }
  return { value: value['value'] };
}

function decodeSocketMessage(data: unknown): OperationData {
  if (typeof data !== 'string') throw new TypeError('Socket message was not text');
  const value: unknown = JSON.parse(data);
  if (!isRecord(value) || typeof value['kind'] !== 'string') {
    throw new TypeError('Invalid socket message');
  }
  if (value['kind'] === 'connected' && typeof value['connection'] === 'number') {
    return { kind: 'connected', connection: value['connection'] };
  }
  if (value['kind'] === 'echo' && typeof value['value'] === 'string') {
    return { kind: 'echo', value: value['value'] };
  }
  throw new TypeError('Unknown socket message');
}

type OperationData = Extract<
  OperationResultOf<BrowserContract, 'chat.socket'>,
  { readonly ok: true; readonly status: 101 }
>['data'];

async function readRealtimeMetrics(): Promise<{ readonly unsubscribes: readonly unknown[] }> {
  const response = await fetch(`${__SHIP_REALTIME_ORIGIN__}/realtime-metrics`);
  if (!response.ok) throw new Error('Realtime fixture metrics were unavailable');
  return (await response.json()) as { readonly unsubscribes: readonly unknown[] };
}

async function readMetrics(): Promise<BrowserFixtureMetrics> {
  const response = await fetch(`${__SHIP_FIXTURE_ORIGIN__}/metrics`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error('Fixture metrics were unavailable');
  return (await response.json()) as BrowserFixtureMetrics;
}

async function rejectedName(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return errorName(error);
  }
  throw new Error('Expected the browser operation to reject');
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorName(value: unknown): string {
  if (isRecord(value) && typeof value['name'] === 'string') return value['name'];
  return typeof value;
}

function errorMessage(value: unknown): string {
  if (isRecord(value) && typeof value['message'] === 'string') return value['message'];
  return 'Unknown browser conformance error';
}

function setStatus(value: string): void {
  const output = document.querySelector('#status');
  if (!(output instanceof HTMLOutputElement)) {
    throw new Error('Browser conformance status output is missing');
  }
  output.textContent = value;
}
