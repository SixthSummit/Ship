interface FixtureFailure<TCode extends string, TStatus extends number> {
  readonly ok: false;
  readonly status: TStatus;
  readonly error: {
    readonly code: TCode;
    readonly message: string;
    readonly details?: unknown;
  };
}

interface FixtureSuccess<TStatus extends number, TData> {
  readonly ok: true;
  readonly status: TStatus;
  readonly data: TData;
}

export interface FixtureContract {
  readonly operations: {
    readonly 'accounts.get': {
      readonly input: {
        readonly params: { readonly accountId: string };
        readonly query?: { readonly include?: readonly ('owner' | 'teams')[] };
        readonly body?: never;
      };
      readonly transport: 'http';
      readonly result:
        | FixtureSuccess<200, { readonly id: string; readonly ownerId: string | null }>
        | FixtureFailure<'ACCOUNT_NOT_FOUND', 404>;
    };
    readonly 'accounts.create': {
      readonly input: {
        readonly params?: never;
        readonly query?: never;
        readonly body: { readonly name: string };
      };
      readonly transport: 'http';
      readonly result:
        | FixtureSuccess<201, { readonly id: string; readonly name: string }>
        | FixtureFailure<'CONFLICT', 409>;
    };
    readonly 'accounts.delete': {
      readonly input: {
        readonly params: { readonly accountId: string };
        readonly query?: never;
        readonly body?: never;
      };
      readonly transport: 'http';
      readonly result: FixtureSuccess<204, undefined> | FixtureFailure<'ACCOUNT_NOT_FOUND', 404>;
    };
    readonly 'public.status': {
      readonly input: { readonly query?: { readonly delayMs?: number } };
      readonly transport: 'http';
      readonly result: FixtureSuccess<200, { readonly ready: true }>;
    };
    readonly 'reports.download': {
      readonly input: { readonly params: { readonly reportId: string } };
      readonly transport: 'download';
      readonly result: FixtureSuccess<200, Blob> | FixtureFailure<'REPORT_NOT_FOUND', 404>;
    };
    readonly 'assets.upload': {
      readonly input: { readonly body: FormData };
      readonly transport: 'upload';
      readonly result:
        | FixtureSuccess<201, { readonly assetId: string }>
        | FixtureFailure<'UPLOAD_REJECTED', 422>;
    };
    readonly 'events.watch': {
      readonly input: { readonly query?: { readonly after?: string } };
      readonly transport: 'stream';
      readonly result: FixtureSuccess<200, ReadableStream<Uint8Array>>;
    };
    readonly 'agent.stream': {
      readonly input: {
        readonly params: { readonly agentId: string };
        readonly query?: {
          readonly mode?: 'frames' | 'error-after-frame' | 'error-before-frame' | 'open';
        };
        readonly body?: never;
      };
      readonly transport: 'stream';
      readonly result:
        | FixtureSuccess<
            200,
            {
              readonly frame: { readonly delta: string };
              readonly terminal: { readonly tokens: number };
            }
          >
        | FixtureFailure<'AGENT_NOT_FOUND', 404>;
    };
    readonly 'chat.socket': {
      readonly input: { readonly params: { readonly roomId: string } };
      readonly transport: 'socket';
      readonly result: FixtureSuccess<101, WebSocket> | FixtureFailure<'ROOM_NOT_FOUND', 404>;
    };
  };
}

export interface FixtureChannels {
  readonly channels: {
    readonly 'account.updated': {
      readonly scope: 'actor';
      readonly payload: { readonly accountId: string; readonly ownerId: string | null };
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

export interface FixtureContractMetadata {
  readonly fixtureProtocolVersion: 1;
  readonly contractVersion: '0.0.0-fixture.1';
  readonly graphHash: 'sha256:c858de1510d38cbbead7923f59ae053bd31ec5bbb90fd8ee16da5d95de541389';
  readonly operations: Readonly<
    Record<keyof FixtureContract['operations'], { readonly transport: string }>
  >;
  readonly channels: Readonly<
    Record<keyof FixtureChannels['channels'], { readonly scope: 'actor' | 'tenant' | 'resource' }>
  >;
}

export declare const contractMetadata: FixtureContractMetadata;

export declare const clientContract: {
  readonly schemaVersion: 1;
  readonly appId: 'ship-angular-conformance';
  readonly fingerprint: FixtureContractMetadata['graphHash'];
  readonly channels: {
    readonly [TChannel in keyof FixtureChannels['channels']]: {
      readonly scope: FixtureChannels['channels'][TChannel]['scope'];
      readonly payload: string;
      readonly presence: FixtureChannels['channels'][TChannel]['presence'];
    };
  };
  readonly operations: readonly {
    readonly id: keyof FixtureContract['operations'];
    /** Declared for operations the client must be able to address on its own (streams). */
    readonly method?: 'GET' | 'POST';
    readonly path?: string;
    readonly success: readonly { readonly status: number }[];
    readonly errors: readonly { readonly code: string; readonly status: number }[];
    readonly publishes?: readonly (keyof FixtureChannels['channels'])[];
    /** Streaming response projection: `mode: "stream"` per the SSE wire contract. */
    readonly response?: {
      readonly mode: 'stream';
      readonly framing: 'sse';
      readonly frame: unknown;
      readonly terminal?: unknown;
      readonly limits: {
        readonly heartbeatMs: number;
        readonly maxDurationMs: number;
        readonly maxFrames: number;
      };
    };
  }[];
};
