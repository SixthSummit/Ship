/**
 * Gateway process: one Socket.IO gateway for the consumer's declared channels,
 * authenticated through the consumer's own session credential adapter and
 * actor resolver, consuming publications from Redis. Prints a ready line with
 * its port and a summary line on SIGTERM.
 */
import { createRealtimeGateway } from "@sixthsummit/ship-realtime-socketio";
import { projectActivity, publishedChannels } from "../consumer/application.js";
import { sessionActorResolver, sessionCredentialAdapter } from "../consumer/auth.js";
import { realtimeKeyPrefix } from "./compose.js";
import { tenantIds } from "./config.js";
import { capacitySessions } from "./sessions.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`gateway-process requires ${name}`);
  return value;
};

const gatewayId = required("GATEWAY_ID");
let unexpectedErrors = 0;
const gateway = createRealtimeGateway({
  channels: [...publishedChannels, projectActivity],
  auth: {
    credentials: sessionCredentialAdapter(),
    actors: sessionActorResolver(capacitySessions(tenantIds(Number(required("TENANTS"))))),
    authorizationScheme: "ShipSession",
  },
  redis: { url: required("REDIS_URL") },
  keyPrefix: realtimeKeyPrefix(required("PREFIX")),
  gatewayId,
  onUnexpectedError: (error, context) => {
    unexpectedErrors += 1;
    process.stderr.write(`${JSON.stringify({ error: String(error), context })}\n`);
  },
});

const address = await gateway.listen(0, "127.0.0.1");
process.stdout.write(`${JSON.stringify({ ready: true, port: address.port, gatewayId })}\n`);

const shutdown = async () => {
  const subscriptions = gateway.backend.subscriptionCount();
  await gateway.close().catch(() => undefined);
  process.stdout.write(
    `${JSON.stringify({ summary: true, gatewayId, subscriptions, unexpectedErrors })}\n`,
  );
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
