/** JSON-only contract types shared by build-time projectors and browser clients. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonSchema = JsonObject;

export interface ProjectedContractSchema {
  readonly vendor: string;
  readonly jsonSchema: JsonSchema;
  readonly codec?: string;
}

export type ClientContractAccess =
  | { readonly kind: "public" }
  | { readonly kind: "optional-identity" }
  | { readonly kind: "authenticated" }
  | { readonly kind: "system" }
  | { readonly kind: "provider"; readonly provider: string }
  | {
      readonly kind: "permissions";
      readonly mode: "all" | "any";
      readonly permissions: readonly string[];
    };

export interface ClientContract {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly fingerprint: `sha256:${string}`;
  readonly operations: readonly ClientContractOperation[];
  /** Declared realtime channels keyed by id. Carries no transport detail. Absent in pre-realtime manifests. */
  readonly channels?: Readonly<Record<string, ClientContractChannel>>;
}

export type ClientContractChannelScope = "actor" | "tenant" | "resource";

export interface ClientContractChannel {
  readonly scope: ClientContractChannelScope;
  readonly payload: ProjectedContractSchema;
  readonly presence: boolean;
}

export interface ClientContractOperation {
  readonly id: string;
  readonly input: Readonly<Record<string, ProjectedContractSchema>>;
  readonly success: readonly ClientContractSuccess[];
  readonly errors: readonly ClientContractError[];
  readonly access: ClientContractAccess;
  readonly transaction: "none" | "read" | "write";
  readonly transport?: ClientContractTransport;
  /** Present when the executor enforces an idempotency window for this operation. */
  readonly idempotency?: { readonly windowMs: number };
  /** Present when the executor serves this read from a declared cache. */
  readonly cache?: ClientContractCache;
  /** Cache tags this write operation purges after it commits. */
  readonly invalidates?: readonly string[];
  /** Present only for streaming operations; the client returns a stream handle. */
  readonly response?: ClientContractStreamResponse;
  /** Channel ids this operation publishes to. Absent in pre-realtime manifests. */
  readonly publishes?: readonly string[];
}

export interface ClientContractCache {
  readonly ttlMs: number;
  readonly scope: "actor" | "tenant" | "public";
  readonly tags: readonly string[];
  /** The Cache-Control the HTTP adapter emits for this policy. */
  readonly cacheControl: string;
}

export interface ClientContractStreamLimits {
  readonly heartbeatMs: number;
  readonly maxDurationMs: number;
  readonly maxFrames: number;
}

export interface ClientContractStreamResponse {
  readonly mode: "stream";
  readonly framing: "sse";
  readonly frame: ProjectedContractSchema;
  /** The terminal value schema; identical to the operation's status 200 success schema. */
  readonly terminal?: ProjectedContractSchema;
  readonly limits: ClientContractStreamLimits;
}

export interface ClientContractSuccess extends ProjectedContractSchema {
  readonly status: number;
}

export interface ClientContractError {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details?: ProjectedContractSchema;
  /** Application-declared headers required on this failure. */
  readonly headers?: readonly string[];
}

export interface ClientContractTransport {
  readonly kind: string;
  readonly binding?: string;
  readonly metadata?: JsonObject;
}
