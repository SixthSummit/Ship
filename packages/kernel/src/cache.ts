import type { OperationAccess } from "./access.js";
import type { OperationActor } from "./actor.js";
import type { DependencyToken } from "./dependency.js";
import { isDependencyToken } from "./dependency.js";
import type { TenantIdentifier, TenantScope } from "./tenant.js";
import { isTenantScope } from "./tenant.js";

const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const CACHE_TAG_PATTERN = /^[a-z][a-z0-9-]*(?:[.:][a-z0-9-]+)*$/u;
const KEY_NAMESPACE = "ship.cache.v1";
const SCOPED_TAG_SEPARATOR = "@";

/**
 * Who may observe a cached entry.
 *
 * - `actor`: one entry per authenticated actor id.
 * - `tenant`: one entry per authentic {@link TenantScope} identifier (ADR-0008).
 * - `public`: one shared entry; only for operations with no per-caller output.
 */
export type CacheScope = "actor" | "tenant" | "public";

export interface CacheStoreOptions {
  readonly ttlMs: number;
  readonly tags?: readonly string[];
}

export interface CacheBackendHealth {
  readonly available: boolean;
  readonly latencyMs?: number;
  readonly detail?: string;
}

/**
 * Adapter contract for declared read caching. `get` returns `undefined` for a
 * miss so a stored `null` stays distinguishable. `delByTag` is the only
 * invalidation primitive the framework uses; it is driven by the durable
 * cache-invalidation outbox, never by a process-local after-commit callback.
 */
export interface CacheBackend {
  readonly kind: "ship.cache-backend";
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, options: CacheStoreOptions): Promise<void>;
  del(key: string): Promise<void>;
  delByTag(tag: string): Promise<void>;
  health(): Promise<CacheBackendHealth>;
  /**
   * Optional adapter-owned coalescing: concurrent misses for one key run the
   * loader once. Adapters build it with {@link createSingleFlight}; the
   * executor falls back to its own per-process gate when it is absent.
   */
  singleFlight?<TValue>(key: string, run: () => Promise<TValue>): Promise<TValue>;
}

export interface CacheBackendDependencyToken extends DependencyToken<CacheBackend, CacheBackend> {
  readonly scope: "cache";
}

/** The success result stored on a miss and replayed on a hit. */
export interface CachedOperationResult {
  readonly status: number;
  readonly data: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Context available while deriving a cache key, before the handler runs. */
export interface OperationCacheContext {
  readonly requestId: string;
  readonly actor?: OperationActor;
}

export interface OperationCacheTenantArguments<TInput> {
  readonly input: TInput;
  readonly context: OperationCacheContext;
}

/** Read-only view of the caller available to `vary` beside the validated input. */
export interface OperationCacheSubject {
  readonly actor?: OperationActor;
  readonly context: OperationCacheContext;
}

export interface OperationCache<TInput = unknown> {
  /** Entry lifetime. Expiry re-runs the handler. */
  readonly ttlMs: number;
  readonly scope: CacheScope;
  /**
   * Extra key dimensions derived from validated input, such as a
   * representation, and optionally from the resolved subject. A `public`
   * read whose `vary` depends on the actor is really actor-scoped and should
   * declare `scope: "actor"`.
   */
  readonly vary?: (input: TInput, subject: OperationCacheSubject) => readonly string[];
  /** Tags a write operation names in `invalidates` to purge this entry. */
  readonly tags?: readonly string[];
  /**
   * Required for `scope: "tenant"`. Must return an authentic TenantScope from
   * an application-owned authority; a raw request or tenant id is rejected.
   */
  readonly tenant?: (
    arguments_: OperationCacheTenantArguments<TInput>,
  ) => TenantScope | Promise<TenantScope>;
}

/**
 * A tag a write purges for one actor only: the entries a `scope: "actor"`
 * read stored for the actor performing the write.
 */
export interface CacheActorInvalidation {
  readonly tag: string;
  readonly scope: "actor";
}

/**
 * A tag a write purges for one tenant only: the entries a `scope: "tenant"`
 * read stored for the authentic {@link TenantScope} the write derives.
 */
export interface CacheTenantInvalidation<TInput = unknown> {
  readonly tag: string;
  readonly scope: "tenant";
  /** Same contract as `cache.tenant`: an authentic scope from an application authority. */
  readonly tenant: (
    arguments_: OperationCacheTenantArguments<TInput>,
  ) => TenantScope | Promise<TenantScope>;
}

export type CacheInvalidationScope = "global" | "actor" | "tenant";

/** The compiled form of one `invalidates` entry; also accepted as a declaration. */
export interface CacheInvalidation<TInput = unknown> {
  readonly tag: string;
  readonly scope: CacheInvalidationScope;
  readonly tenant?: CacheTenantInvalidation<TInput>["tenant"];
}

/**
 * One `invalidates` entry. The plain string form purges every entry stored
 * under the tag, whatever scope stored it; the object forms purge only the
 * entries stored for the matching subject, mirroring how the cached read's key
 * was scoped. A compiled entry is accepted so an operation can be re-declared
 * from another by spreading it.
 */
export type CacheInvalidationDeclaration<TInput = unknown> =
  | string
  | CacheActorInvalidation
  | CacheTenantInvalidation<TInput>
  | CacheInvalidation<TInput>;

export type CacheDiagnosticCode =
  | "SHIP_CACHE_BACKEND_ID_INVALID"
  | "SHIP_CACHE_KEY_INPUT_NOT_CANONICAL";

export class CacheContractError extends TypeError {
  readonly code: CacheDiagnosticCode;

  constructor(code: CacheDiagnosticCode, message: string) {
    super(message);
    this.name = "CacheContractError";
    this.code = code;
  }
}

/** The provider token that binds a {@link CacheBackend} for cached operations. */
export function cacheBackendDependency(id: string): CacheBackendDependencyToken {
  if (typeof id !== "string" || !BACKEND_ID_PATTERN.test(id)) {
    throw new CacheContractError(
      "SHIP_CACHE_BACKEND_ID_INVALID",
      `cache backend id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
    );
  }
  return Object.freeze({
    kind: "ship.dependency" as const,
    id,
    scope: "cache" as const,
  }) as CacheBackendDependencyToken;
}

export function isCacheBackendDependencyToken(
  value: unknown,
): value is CacheBackendDependencyToken {
  return isDependencyToken(value) && value.scope === "cache";
}

export function isCacheBackend(value: unknown): value is CacheBackend {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.cache-backend" &&
    ["get", "set", "del", "delByTag", "health"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}

export function isCacheTag(value: unknown): value is string {
  return typeof value === "string" && CACHE_TAG_PATTERN.test(value);
}

export function isCacheTagList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((tag, index) => isCacheTag(tag) && value.indexOf(tag) === index)
  );
}

function invalidationTag(value: unknown): string | undefined {
  if (typeof value === "string") return isCacheTag(value) ? value : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const tag = Reflect.get(value, "tag");
  const scope = Reflect.get(value, "scope");
  const tenant = Reflect.get(value, "tenant");
  if (scope === "actor" || scope === "global") {
    if (tenant !== undefined) return undefined;
  } else if (scope === "tenant") {
    if (typeof tenant !== "function") return undefined;
  } else {
    return undefined;
  }
  return isCacheTag(tag) ? tag : undefined;
}

/**
 * Accepts a non-empty list of plain tags, `{ tag, scope: "actor" }` and
 * `{ tag, scope: "tenant", tenant }` entries whose tags are unique across
 * every form.
 */
export function isCacheInvalidationList(
  value: unknown,
): value is readonly CacheInvalidationDeclaration[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const item of value) {
    const tag = invalidationTag(item);
    if (tag === undefined || seen.has(tag)) return false;
    seen.add(tag);
  }
  return true;
}

/** Normalizes declared `invalidates` entries into their compiled form. */
export function normalizeCacheInvalidations<TInput>(
  declarations: readonly CacheInvalidationDeclaration<TInput>[],
): readonly CacheInvalidation<TInput>[] {
  return Object.freeze(
    declarations.map((item) => {
      if (typeof item === "string") return Object.freeze({ tag: item, scope: "global" as const });
      if (item.scope === "tenant") {
        return Object.freeze({
          tag: item.tag,
          scope: "tenant" as const,
          tenant: item.tenant as CacheTenantInvalidation<TInput>["tenant"],
        });
      }
      return Object.freeze({ tag: item.tag, scope: item.scope });
    }),
  );
}

export function isOperationCache(value: unknown): value is OperationCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ttlMs = Reflect.get(value, "ttlMs");
  const scope = Reflect.get(value, "scope");
  const vary = Reflect.get(value, "vary");
  const tags = Reflect.get(value, "tags");
  const tenant = Reflect.get(value, "tenant");
  if (!Number.isInteger(ttlMs) || Number(ttlMs) <= 0) return false;
  if (scope !== "actor" && scope !== "tenant" && scope !== "public") return false;
  if (vary !== undefined && typeof vary !== "function") return false;
  if (tags !== undefined && !isCacheTagList(tags)) return false;
  if (scope === "tenant" ? typeof tenant !== "function" : tenant !== undefined) return false;
  return true;
}

export function isCachedOperationResult(value: unknown): value is CachedOperationResult {
  if (typeof value !== "object" || value === null) return false;
  const status = Reflect.get(value, "status");
  const headers = Reflect.get(value, "headers");
  return (
    Number.isInteger(status) &&
    Number(status) >= 200 &&
    Number(status) <= 299 &&
    "data" in value &&
    (headers === undefined ||
      (typeof headers === "object" &&
        headers !== null &&
        Object.values(headers).every((item) => typeof item === "string")))
  );
}

export interface CacheKeyParts {
  readonly operationId: string;
  /** Contract fingerprint or operation graph version; busts keys when policy or schemas change. */
  readonly version: string;
  readonly scopeKey: string;
  /** Validated operation input. */
  readonly input: unknown;
  readonly vary?: readonly string[];
}

/**
 * Framework-owned key derivation. A consumer never supplies a raw key: every
 * dimension is either declared (operation id, graph version, scope) or derived
 * from validated input.
 */
export async function deriveCacheKey(parts: CacheKeyParts): Promise<string> {
  const canonical = canonicalJson([
    parts.operationId,
    parts.version,
    parts.scopeKey,
    parts.input,
    [...(parts.vary ?? [])],
  ]);
  const digest = await sha256Base64Url(canonical);
  return `${KEY_NAMESPACE}:${parts.operationId}:${digest}`;
}

/** Derives the scope component of a key from an actor, an authentic tenant scope, or nothing. */
export function cacheScopeKey(
  scope: CacheScope,
  subject: OperationActor | TenantScope | undefined,
): string {
  if (scope === "public") return "public";
  if (scope === "tenant") {
    if (!isTenantScope(subject)) {
      throw new CacheContractError(
        "SHIP_CACHE_KEY_INPUT_NOT_CANONICAL",
        "tenant-scoped cache keys require an authentic TenantScope",
      );
    }
    return `tenant:${cacheTenantKey(subject.tenantId)}`;
  }
  const actorId =
    typeof subject === "object" && subject !== null ? Reflect.get(subject, "id") : undefined;
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new CacheContractError(
      "SHIP_CACHE_KEY_INPUT_NOT_CANONICAL",
      "actor-scoped cache keys require an authenticated actor",
    );
  }
  return `actor:${actorId}`;
}

/** The canonical scope component for a tenant identifier; type-tagged so `1` and `"1"` never collide. */
export function cacheTenantKey(tenantId: TenantIdentifier): string {
  return typeof tenantId === "number" ? `n${tenantId}` : `s${tenantId}`;
}

/**
 * The tag an actor- or tenant-scoped entry is stored under in addition to its
 * plain tag, qualified by the same scope key that keyed the entry
 * (`actor:<id>` or `tenant:<key>`, see {@link cacheScopeKey}). Purging it
 * removes one subject's entries and leaves every other subject's warm;
 * purging the plain tag still removes them all.
 */
export function scopedCacheTag(tag: string, scopeKey: string): string {
  return `${tag}${SCOPED_TAG_SEPARATOR}${scopeKey}`;
}

/**
 * Per-key promise coalescing. Adapters expose it as `singleFlight` so a burst
 * of concurrent misses runs the loader once per process.
 */
export function createSingleFlight(): <TValue>(
  key: string,
  run: () => Promise<TValue>,
) => Promise<TValue> {
  const inFlight = new Map<string, Promise<unknown>>();
  return <TValue>(key: string, run: () => Promise<TValue>): Promise<TValue> => {
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<TValue>;
    const created = (async () => run())().finally(() => {
      if (inFlight.get(key) === created) inFlight.delete(key);
    });
    inFlight.set(key, created);
    return created as Promise<TValue>;
  };
}

/**
 * Projects a declared cache policy onto an HTTP `Cache-Control` value.
 *
 * `scope: "public"` describes the key (one entry for every caller allowed in),
 * not who may store the response: only an operation whose access is
 * `publicAccess()` projects `public`. Every other access — or an absent one —
 * projects `private`, so a shared cache between the client and the app never
 * stores a permission-gated body.
 */
export function cacheControlHeader(
  cache: {
    readonly ttlMs: number;
    readonly scope: CacheScope;
  },
  access?: Pick<OperationAccess, "kind">,
): string {
  const seconds = Math.max(0, Math.floor(cache.ttlMs / 1000));
  const shared = cache.scope === "public" && access?.kind === "public";
  return `${shared ? "public" : "private"}, max-age=${seconds}`;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Stable JSON for key derivation: object keys sorted, `undefined` preserved as
 * a tagged marker, and every value shape named so two different inputs can
 * never collapse onto one key.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return '["u"]';
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value ? "true" : "false";
  if (type === "bigint") return `["b",${JSON.stringify(String(value))}]`;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new CacheContractError(
        "SHIP_CACHE_KEY_INPUT_NOT_CANONICAL",
        "cache key input may not contain NaN or Infinity",
      );
    }
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new CacheContractError(
        "SHIP_CACHE_KEY_INPUT_NOT_CANONICAL",
        "cache key input may not contain an invalid Date",
      );
    }
    return `["d",${JSON.stringify(value.toISOString())}]`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`);
    return `{${entries.join(",")}}`;
  }
  throw new CacheContractError(
    "SHIP_CACHE_KEY_INPUT_NOT_CANONICAL",
    `cache key input contains a value that cannot be canonicalized: ${Object.prototype.toString.call(value)}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
