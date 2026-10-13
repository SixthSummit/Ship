/**
 * The Redis pub/sub envelope exchanged between API publishers and gateways.
 * This is an adapter-internal format; it is not the client wire protocol.
 */
export type RealtimeEnvelope =
  | {
      readonly v: 1;
      readonly kind: "message";
      readonly channel: string;
      readonly scopeKey: string;
      readonly payload: unknown;
      readonly publishedAt: string;
      readonly origin: string;
    }
  | {
      readonly v: 1;
      readonly kind: "presence";
      readonly channel: string;
      readonly scopeKey: string;
      readonly event: "joined" | "left";
      readonly actorId: string;
      readonly count: number;
      readonly publishedAt: string;
      readonly origin: string;
    };

export function encodeEnvelope(envelope: RealtimeEnvelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelope(raw: string): RealtimeEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.channel !== "string" ||
    typeof record.scopeKey !== "string" ||
    typeof record.publishedAt !== "string" ||
    typeof record.origin !== "string"
  ) {
    return undefined;
  }
  if (record.kind === "message" && "payload" in record) return record as RealtimeEnvelope;
  if (
    record.kind === "presence" &&
    (record.event === "joined" || record.event === "left") &&
    typeof record.actorId === "string" &&
    typeof record.count === "number"
  ) {
    return record as RealtimeEnvelope;
  }
  return undefined;
}
