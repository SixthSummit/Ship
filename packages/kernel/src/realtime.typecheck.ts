/** Type-level CI contract for channel declarations and the publish capability. */
import { z } from "zod";
import { publicAccess } from "./access.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import type {
  AnyChannelPublisher,
  ChannelPublisher,
  ChannelPublisherRegistry,
  RealtimeBackend,
  RealtimePublishBackend,
} from "./realtime.js";
import { defineChannel, narrowChannelPublisher } from "./realtime.js";
import type { TenantScope } from "./tenant.js";

const statusPayload = z.object({ status: z.enum(["open", "closed"]), version: z.number().int() });

const actorChannel = defineChannel({ id: "activity.feed", scope: "actor", payload: statusPayload });
const tenantChannel = defineChannel({
  id: "tenant.updates",
  scope: "tenant",
  payload: statusPayload,
  presence: true,
  coalesce: { windowMs: 50, key: (value) => value.status },
});
const resourceChannel = defineChannel({
  id: "board.updates",
  scope: "resource",
  payload: statusPayload,
  authorizeSubscription: async (actor, resourceRef, context) => {
    const permissions: ReadonlySet<string> | undefined = actor.permissions;
    const ref: string = resourceRef;
    const requestId: string = context.requestId;
    return permissions?.has(`board:${ref}:${requestId}`) ?? false;
  },
});

// Literal inference is retained.
const actorId: "activity.feed" = actorChannel.id;
const tenantPresence: true = tenantChannel.presence;
const actorPresence: false = actorChannel.presence;
const publicationId: string = actorChannel.publication.id;
void [actorId, tenantPresence, actorPresence, publicationId];

// Resource channels without a policy are rejected at runtime (SHIP_CHANNEL_AUTHORIZATION_REQUIRED).
defineChannel({
  id: "x.y",
  scope: "actor",
  payload: statusPayload,
  // @ts-expect-error the coalesce key is typed by the payload schema.
  coalesce: { windowMs: 5, key: (v) => v.missing },
});

defineOperation({
  id: "activity.touch",
  input: { body: z.object({ status: z.enum(["open", "closed"]) }) },
  output: { 202: z.object({ accepted: z.literal(true) }) },
  successStatus: 202,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {
    feed: actorChannel.publication,
    tenant: tenantChannel.publication,
    board: resourceChannel.publication,
  },
  publishes: [actorChannel, tenantChannel, resourceChannel],
  handler: async ({ input, services, context }) => {
    const feed: ChannelPublisher<typeof actorChannel> = services.feed;
    await feed.publish(context.actor?.id ?? "anonymous", { status: input.body.status, version: 1 });
    // @ts-expect-error actor channels take a string scope key, not a tenant scope.
    await services.feed.publish({} as TenantScope, { status: "open", version: 1 });
    // @ts-expect-error payloads are typed by the channel schema.
    await services.feed.publish("actor", { status: "unknown", version: 1 });
    // @ts-expect-error tenant channels require an authentic tenant scope value.
    await services.tenant.publish("acme", { status: "open", version: 1 });
    await services.tenant.publish({} as TenantScope, { status: "closed", version: 2 });
    await services.board.publish("board-1", { status: "open", version: 3 });
    return { accepted: true as const };
  },
});

defineModule({
  id: "activity",
  operations: [],
  providers: [],
  imports: [],
  exports: [],
  channels: [actorChannel, tenantChannel, resourceChannel],
});

// A publish-only backend is assignable where the full backend is not required, never the reverse.
declare const publishOnly: RealtimePublishBackend;
declare const full: RealtimeBackend;
const widened: RealtimePublishBackend = full;
// @ts-expect-error publish-only backends cannot host subscriptions.
const narrowed: RealtimeBackend = publishOnly;
void [widened, narrowed];

// A typed publisher erases to AnyChannelPublisher; narrowing restores the channel's types.
declare const registry: ChannelPublisherRegistry;
declare const typedFeed: ChannelPublisher<typeof actorChannel>;
const erased: AnyChannelPublisher = typedFeed;
const restored: ChannelPublisher<typeof actorChannel> = narrowChannelPublisher(
  erased,
  actorChannel,
);
const viaRegistry: ChannelPublisher<typeof tenantChannel> = registry.for(tenantChannel);
void restored.publish("actor", { status: "open", version: 1 });
// @ts-expect-error the narrowed publisher is typed by the channel payload again.
void restored.publish("actor", { status: "unknown", version: 1 });
// @ts-expect-error a tenant channel's typed publisher still requires an authentic scope.
void viaRegistry.publish("acme", { status: "open", version: 1 });
// The erased path accepts either scope kind and any payload; validation happens at runtime.
void erased.publish({} as TenantScope, { anything: true });
void registry.publish("activity.feed", "actor", { status: "open", version: 1 });
