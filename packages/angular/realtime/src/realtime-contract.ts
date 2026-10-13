/**
 * Transport-neutral projection of the ShipAPI manifest's declared realtime publication
 * surface (`channels` and `operations[id].publishes`).
 *
 * The runtime manifest carries a schema *reference* for each channel payload, so the
 * payload type itself is supplied by the application's generated contract type. This
 * mirrors how `/operations` separates `OperationTypeContract` (types) from the browser
 * client manifest (runtime declarations).
 */

/** Scope kinds a declared channel can be subscribed under. */
export type RealtimeChannelScope = 'actor' | 'tenant' | 'resource';

/** Type-level declaration of one channel. */
export interface RealtimeChannelTypeDefinition {
  readonly scope: RealtimeChannelScope;
  readonly payload: unknown;
  readonly presence: boolean;
}

/** Application-typed view of the manifest's `channels` map. */
export interface RealtimeChannelContract {
  readonly channels: Readonly<Record<string, RealtimeChannelTypeDefinition>>;
}

/** Every channel id declared by a contract. */
export type RealtimeChannelId<TContract extends RealtimeChannelContract> = Extract<
  keyof TContract['channels'],
  string
>;

/** The payload type published on one channel. */
export type RealtimePayloadOf<
  TContract extends RealtimeChannelContract,
  TChannel extends RealtimeChannelId<TContract>,
> = TContract['channels'][TChannel]['payload'];

/** Channel ids whose contract declares presence tracking. */
export type RealtimePresenceChannelId<TContract extends RealtimeChannelContract> = {
  [TChannel in RealtimeChannelId<TContract>]: TContract['channels'][TChannel]['presence'] extends true
    ? TChannel
    : never;
}[RealtimeChannelId<TContract>];

/** Runtime declaration of one channel as ShipAPI projects it. */
export interface RealtimeChannelDeclaration {
  readonly scope: RealtimeChannelScope;
  /** Schema reference for the published payload. The client never resolves it. */
  readonly payload: string;
  readonly presence: boolean;
}

/** Runtime declaration of the channels one operation publishes to. */
export interface RealtimeOperationDeclaration {
  readonly publishes?: readonly string[];
}

/**
 * Either shape ShipAPI projects its operations in: the keyed map the wire protocol
 * describes, or the id-carrying array the current browser client manifest already uses.
 */
export type RealtimeOperationDeclarations =
  | Readonly<Record<string, RealtimeOperationDeclaration>>
  | readonly (RealtimeOperationDeclaration & { readonly id: string })[];

/** Browser-safe subset of the ShipAPI manifest consumed by `./realtime`. */
export interface RealtimeManifest<
  TContract extends RealtimeChannelContract = RealtimeChannelContract,
> {
  readonly channels: {
    readonly [TChannel in RealtimeChannelId<TContract>]: RealtimeChannelDeclaration;
  };
  readonly operations?: RealtimeOperationDeclarations;
}

function operationEntries(
  operations: RealtimeOperationDeclarations | undefined
): readonly (readonly [string, RealtimeOperationDeclaration])[] {
  if (operations === undefined) return [];
  if (Array.isArray(operations)) {
    return (operations as readonly (RealtimeOperationDeclaration & { readonly id: string })[]).map(
      operation => [operation.id, operation] as const
    );
  }
  return Object.entries(operations as Readonly<Record<string, RealtimeOperationDeclaration>>);
}

const SCOPES: ReadonlySet<string> = new Set<RealtimeChannelScope>(['actor', 'tenant', 'resource']);

/**
 * Validate a manifest's realtime projection and index its channel declarations.
 *
 * Fails closed: an unusable manifest is a wiring defect, not a runtime condition the
 * application can recover from by reconnecting.
 */
export function indexRealtimeChannels(
  manifest: RealtimeManifest<RealtimeChannelContract>
): ReadonlyMap<string, RealtimeChannelDeclaration> {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('ShipAngular realtime manifest is not an object');
  }
  const channels = manifest.channels;
  if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) {
    throw new TypeError('ShipAngular realtime manifest does not declare a channels map');
  }
  const indexed = new Map<string, RealtimeChannelDeclaration>();
  for (const [id, declaration] of Object.entries(channels)) {
    if (
      typeof declaration !== 'object' ||
      declaration === null ||
      !SCOPES.has((declaration as RealtimeChannelDeclaration).scope) ||
      typeof (declaration as RealtimeChannelDeclaration).payload !== 'string' ||
      typeof (declaration as RealtimeChannelDeclaration).presence !== 'boolean'
    ) {
      throw new TypeError(`ShipAngular realtime manifest declares an invalid channel: ${id}`);
    }
    indexed.set(id, declaration as RealtimeChannelDeclaration);
  }
  for (const [operationId, operation] of operationEntries(manifest.operations)) {
    for (const channel of operation?.publishes ?? []) {
      if (!indexed.has(channel)) {
        throw new TypeError(
          `ShipAngular realtime manifest operation ${operationId} publishes to undeclared channel ${channel}`
        );
      }
    }
  }
  return indexed;
}

/** Channel ids one declared operation publishes to, in manifest order. */
export function channelsPublishedBy(
  manifest: RealtimeManifest<RealtimeChannelContract>,
  operationId: string
): readonly string[] {
  for (const [id, operation] of operationEntries(manifest.operations)) {
    if (id === operationId) return operation.publishes ?? [];
  }
  return [];
}
