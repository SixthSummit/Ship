import { GenericContainer, type StartedTestContainer } from "testcontainers";

export interface RedisTestContainer {
  readonly container: StartedTestContainer;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** Starts an ephemeral Redis 7 container for the integration lane. */
export async function startRedis(): Promise<RedisTestContainer> {
  const container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  return {
    container,
    host,
    port,
    url: `redis://${host}:${port}`,
    stop: async () => {
      await container.stop().catch(() => undefined);
    },
  };
}

let sequence = 0;

/** A unique BullMQ prefix per test so queues never observe each other's keys. */
export function uniquePrefix(label: string): string {
  sequence += 1;
  return `${label}-${process.pid}-${Date.now().toString(36)}-${sequence}`;
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 20_000,
  intervalMs = 50,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}
