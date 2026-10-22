import type { AnyChannel, DependencyToken, RealtimePublishBackend } from "@sixthsummit/ship-core";
import {
  defineOperation,
  dependency,
  isRealtimeIntrospection,
  isRealtimePublishBackend,
  valueProvider,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import type { ConsolePanelOptions } from "./jobs.js";
import { consoleAccess } from "./permission.js";

export interface ConsoleRealtimeOptions extends ConsolePanelOptions {
  /** The backend this process publishes through (a gateway or a publish-only backend). */
  readonly backend: RealtimePublishBackend;
  /** Channels to list; typically every channel the application declares. */
  readonly channels: readonly AnyChannel[];
}

const channelViewSchema = z.object({
  channelId: z.string(),
  scope: z.enum(["actor", "tenant", "resource"]),
  presence: z.boolean(),
  /** Live subscriptions this backend instance holds; absent without introspection. */
  subscribers: z.number().int().optional(),
  scopes: z.number().int().optional(),
  lastPublishedAt: z.string().optional(),
  lastScopeKey: z.string().optional(),
});
const channelsOutput = z.object({
  backend: z.object({
    id: z.string(),
    adapter: z.string(),
    ok: z.boolean(),
    detail: z.string().optional(),
  }),
  capabilities: z.object({ introspection: z.boolean() }),
  channels: z.array(channelViewSchema),
});

/**
 * The realtime panel: every declared channel with the subscriber and scope
 * counts this backend instance observes and when it last accepted a
 * publication, next to the backend's own health.
 */
export function defineConsoleRealtimeOperations(options: ConsoleRealtimeOptions) {
  const { prefix, basePath } = options;
  if (!isRealtimePublishBackend(options.backend)) {
    throw new TypeError("console realtime panel requires a RealtimePublishBackend");
  }
  const token: DependencyToken<RealtimePublishBackend> = dependency(`${prefix}.realtime-backend`);
  const declared = Object.freeze(
    [...options.channels].sort((left, right) => left.id.localeCompare(right.id)),
  );

  const channels = defineOperation({
    id: `${prefix}.realtime.channels` as const,
    transport: http.get(`${basePath}/realtime`),
    input: {},
    output: { 200: channelsOutput },
    successStatus: 200,
    errors: [],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { realtime: token },
    handler: async ({ services }) => {
      const backend = services.realtime;
      const health = await backend.health();
      const introspection = isRealtimeIntrospection(backend.introspection)
        ? backend.introspection
        : undefined;
      const states = new Map(
        (introspection ? await introspection.channels() : []).map((item) => [item.channelId, item]),
      );
      return {
        backend: {
          id: backend.id,
          adapter: health.adapter,
          ok: health.ok,
          ...(health.detail !== undefined ? { detail: health.detail } : {}),
        },
        capabilities: { introspection: introspection !== undefined },
        channels: declared.map((channel) => {
          const state = states.get(channel.id);
          return {
            channelId: channel.id,
            scope: channel.scope,
            presence: channel.presence,
            ...(state
              ? {
                  subscribers: state.subscribers,
                  scopes: state.scopes,
                  ...(state.lastPublishedAt
                    ? { lastPublishedAt: state.lastPublishedAt.toISOString() }
                    : {}),
                  ...(state.lastScopeKey !== undefined ? { lastScopeKey: state.lastScopeKey } : {}),
                }
              : {}),
          };
        }),
      };
    },
  });

  return Object.freeze({
    token,
    channels,
    providers: Object.freeze([valueProvider(token, options.backend)] as const),
    operations: Object.freeze([channels] as const),
  });
}

export type ConsoleRealtimeOperations = ReturnType<typeof defineConsoleRealtimeOperations>;
