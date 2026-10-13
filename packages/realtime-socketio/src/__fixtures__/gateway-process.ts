/**
 * Gateway fixture process: one Socket.IO gateway consuming publications
 * from Redis. Prints a JSON line with its port once listening and closes
 * gracefully on SIGTERM. SIGKILL simulates a crash for the presence sweep.
 */

import { Redis } from "ioredis";
import { createRealtimeGateway } from "../gateway.js";
import { actors, channels, credentials, tenantScopes } from "./shared.js";

const grants =
  process.env.AUTHORIZE_DELIVERY === "true" || process.env.FENCED_DELIVERY === "true"
    ? new Redis(process.env.REDIS_URL as string, { enableOfflineQueue: false })
    : undefined;
grants?.on("error", () => undefined);
const fencedDelivery = process.env.FENCED_DELIVERY === "true";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withGrantFence(
  actorId: string,
  signal: AbortSignal,
  deliver: () => void,
): Promise<void> {
  if (!grants) throw new Error("grant source unavailable");
  const gatewayId = process.env.GATEWAY_ID as string;
  if ((await grants.get(`realtime:pause:${actorId}`)) === "1") {
    await grants.set(`realtime:queued:${actorId}:${gatewayId}`, "1");
    while ((await grants.get(`realtime:pause:${actorId}`)) === "1") {
      if (signal.aborted) throw new Error("grant check timed out");
      await sleep(10);
    }
  }
  const lockKey = `realtime:grant-lock:${actorId}`;
  const token = crypto.randomUUID();
  while ((await grants.set(lockKey, token, "PX", 5_000, "NX")) !== "OK") {
    if (signal.aborted) throw new Error("grant lock unavailable");
    await sleep(10);
  }
  try {
    const revoked = (await grants.get(`realtime:revoked:${actorId}`)) === "1";
    await grants.set(`realtime:checked:${actorId}:${gatewayId}`, revoked ? "revoked" : "allowed");
    if (!revoked) deliver();
  } finally {
    await grants.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      lockKey,
      token,
    );
  }
}

const gateway = createRealtimeGateway({
  channels,
  auth: { credentials, actors },
  redis: { url: process.env.REDIS_URL as string },
  tenantScopes,
  ...(grants && !fencedDelivery
    ? {
        authorizeDelivery: async ({ actor }: { actor?: { id: string } }) =>
          Boolean(actor && (await grants.get(`realtime:revoked:${actor.id}`)) !== "1"),
      }
    : {}),
  ...(fencedDelivery && grants
    ? {
        authorizeSubscription: async ({ actor }: { actor?: { id: string } }) =>
          Boolean(actor && (await grants.get(`realtime:revoked:${actor.id}`)) !== "1"),
        withAuthorizedDelivery: async (
          { actor, signal }: { actor?: { id: string }; signal: AbortSignal },
          deliver: () => void,
        ) => {
          if (!actor) throw new Error("actor unavailable");
          await withGrantFence(actor.id, signal, deliver);
        },
      }
    : {}),
  gatewayId: process.env.GATEWAY_ID,
  heartbeat: {
    intervalMs: Number(process.env.HEARTBEAT_MS ?? 500),
    ttlMs: Number(process.env.HEARTBEAT_TTL_MS ?? 1_500),
  },
  limits: {
    sendBufferHighWaterMark: Number(process.env.SEND_BUFFER ?? 1_000),
  },
  onUnexpectedError: (error, context) => {
    process.stderr.write(`${JSON.stringify({ error: String(error), context })}\n`);
  },
});

const address = await gateway.listen(0, "127.0.0.1");
process.stdout.write(
  `${JSON.stringify({ ready: true, port: address.port, gatewayId: gateway.gatewayId })}\n`,
);

process.on("SIGTERM", () => {
  gateway.close().then(
    async () => {
      await grants?.quit();
      process.exit(0);
    },
    () => process.exit(1),
  );
});
