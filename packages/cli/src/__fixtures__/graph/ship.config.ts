import {
  channelPublisherProvider,
  defineApp,
  defineChannel,
  defineModule,
  defineOperation,
  defineProvider,
  dependency,
  publicAccess,
  type RealtimePublishBackend,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";

const clock = dependency<{ now(): string }>("platform.clock");
const activity = defineChannel({
  id: "accounts.activity",
  scope: "actor",
  payload: z.object({ accountId: z.string() }),
});
const realtime: RealtimePublishBackend = {
  kind: "ship.realtime-backend",
  id: "fixture",
  publish: async () => undefined,
  health: async () => ({ ok: true, adapter: "fixture" }),
  close: async () => undefined,
};

const platform = defineModule({
  id: "platform",
  providers: [
    defineProvider({
      token: clock,
      dependencies: {},
      lifetime: "singleton",
      create: () => ({ now: () => "2026-09-04T00:00:00.000Z" }),
    }),
  ],
  operations: [],
  imports: [],
  exports: [clock],
});

const readAccount = defineOperation({
  id: "accounts.read",
  transport: http.get("/accounts/:accountId"),
  input: { params: z.object({ accountId: z.string() }) },
  output: { 200: z.object({ accountId: z.string(), observedAt: z.string() }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: { clock, activity: activity.publication },
  publishes: [activity],
  handler: async ({ input, services }) => {
    await services.activity.publish(input.params.accountId, {
      accountId: input.params.accountId,
    });
    return {
      accountId: input.params.accountId,
      observedAt: services.clock.now(),
    };
  },
});

const accounts = defineModule({
  id: "accounts",
  providers: [channelPublisherProvider(activity, realtime)],
  operations: [readAccount],
  imports: ["platform"],
  exports: [],
  channels: [activity],
});

export const app = defineApp({ id: "graph-fixture", modules: [platform, accounts] });
