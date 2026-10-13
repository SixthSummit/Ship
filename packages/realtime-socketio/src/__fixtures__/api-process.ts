/**
 * API fixture process: publishes through the kernel channel publisher bound
 * to the Redis publisher backend, exactly as an operation handler would.
 * A tiny HTTP control surface lets the test drive publications and read the
 * publish() call latency the API process observed.
 */
import { createServer } from "node:http";
import { createChannelPublisher, operationActor, type TenantScope } from "@sixthsummit/ship-core";
import { createRealtimePublisher } from "../publisher.js";
import { channels, feed, percentile, room, strict, tenantScopes } from "./shared.js";

const publisher = createRealtimePublisher({
  redis: { url: process.env.REDIS_URL as string },
  channels,
  id: "api",
});
const publishers = {
  feed: createChannelPublisher(feed, publisher),
  room: createChannelPublisher(room, publisher),
  strict: createChannelPublisher(strict, publisher),
};

interface PublishCommand {
  readonly channel: keyof typeof publishers;
  readonly scopeKey: string;
  readonly count?: number;
  readonly ratePerSecond?: number;
  readonly paddingBytes?: number;
}

async function scopeFor(
  channel: keyof typeof publishers,
  scopeKey: string,
): Promise<string | TenantScope> {
  if (channel !== "room") return scopeKey;
  return tenantScopes.issue({
    tenantId: scopeKey,
    requestId: "api-fixture",
    actor: operationActor({ id: "api", permissions: [`tenant:${scopeKey}`] }),
  });
}

async function run(command: PublishCommand) {
  const count = command.count ?? 1;
  const latencies: number[] = [];
  const padding = command.paddingBytes ? "x".repeat(command.paddingBytes) : undefined;
  const scope = await scopeFor(command.channel, command.scopeKey);
  const startedAt = performance.now();
  const intervalMs = command.ratePerSecond ? 1_000 / command.ratePerSecond : 0;
  let dropped = 0;
  for (let n = 1; n <= count; n += 1) {
    const before = performance.now();
    const payload = padding ? { n, sentAt: Date.now(), padding } : { n, sentAt: Date.now() };
    await (
      publishers[command.channel] as { publish(scope: unknown, payload: unknown): Promise<void> }
    ).publish(scope, payload);
    latencies.push(performance.now() - before);
    if (intervalMs > 0) {
      const target = startedAt + n * intervalMs;
      const wait = target - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const elapsedMs = performance.now() - startedAt;
  await publisher.flush();
  dropped += 0;
  return {
    published: count,
    dropped,
    elapsedMs: Math.round(elapsedMs),
    achievedRate: Math.round((count / elapsedMs) * 1_000),
    publishLatencyMs: {
      p50: round(percentile(latencies, 0.5)),
      p95: round(percentile(latencies, 0.95)),
      p99: round(percentile(latencies, 0.99)),
      max: round(Math.max(...latencies)),
    },
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", async () => {
    try {
      if (request.url === "/health") {
        response.end(JSON.stringify(await publisher.health()));
        return;
      }
      const result = await run(JSON.parse(body) as PublishCommand);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);
});

process.on("SIGTERM", () => {
  server.close();
  publisher.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
