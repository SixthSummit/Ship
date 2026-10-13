import { createHmac, timingSafeEqual } from "node:crypto";
import { Packr } from "msgpackr";
import type { Cache, CacheSetOptions } from "./Cache.js";

/**
 * Frame version byte for HMAC-signed RedisCache values (F14). The
 * first byte of a signed payload is one of these magic markers so
 * `get()` can:
 *   - tell signed values from legacy unsigned ones (signing was
 *     introduced post-shipping; consumers may have old entries),
 *   - rotate the MAC scheme in a future release without breaking
 *     verifying caches.
 *
 * Layout (when signing enabled): `[FRAME_BYTE][32-byte MAC][msgpackr bytes]`
 * Layout (when signing disabled): raw msgpackr bytes (unchanged).
 */
const FRAME_SIGNED_V1 = 0x01;
const MAC_LENGTH = 32; // SHA-256 output

/**
 * Redis-backed cache with msgpackr serialization.
 *
 * Production default. Designed to be Redis-client-agnostic: any object that
 * implements the methods in `RedisLike` works (production: ioredis client;
 * tests: hand-rolled fake).
 *
 * Serialization: msgpackr encodes/decodes via Buffer — faster than JSON,
 * preserves Date / Map / Set / undefined / bigint that JSON loses.
 *
 * Tag tracking: each `set(key, value, { tags })` SADDs the key into a
 * sibling Redis Set named `<tagPrefix><tag>`. `invalidateTag(tag)` SMEMBERs,
 * deletes them all, and drops the tag set. Atomic for typical use because
 * tag-set membership and value-key live in the same Redis instance — for
 * cluster mode, hash-tag the keys to keep them on one shard.
 *
 * Key namespacing: every key is prefixed with `keyPrefix` so cache content
 * can't bleed across services or framework versions.
 */

export interface RedisLike {
  set(key: string, value: Buffer | string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  getBuffer(key: string): Promise<Buffer | null>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface RedisCacheOptions {
  /** Redis client. */
  client: RedisLike;
  /**
   * String prepended to every key (and tag set name) to namespace the
   * cache. Recommended `${SERVICE_NAME}:${pkg.version}:` so a deploy of
   * a new version can't read stale entries.
   */
  keyPrefix?: string;
  /** Tag-set namespace prefix. Default `"tag:"`. */
  tagPrefix?: string;
  /**
   * **Opt-in (F14) HMAC integrity key.** When set, every `set` /
   * `setIfAbsent` writes `[0x01][HMAC-SHA256(key||msgpackrBytes)][msgpackrBytes]`
   * into Redis; every `get` checks the MAC and returns `null`
   * (deleting the poisoned entry in the background) on mismatch.
   * Disabled by default — adopters running a dedicated Redis don't
   * need it. Enable when the Redis tier is shared with untrusted
   * clustermates (multi-tenant Redis, leaked password, co-located
   * service with the Redis password).
   *
   * `defineEnv` is the recommended boundary: source from an env
   * `CACHE_SIGNING_KEY` of ≥32 random bytes, rotate independently
   * of JWT keys. The framework reads this once at construction;
   * rotating means restarting the process with a new value.
   *
   * Documented in `.cursor/rules/security.mdc` (Cache section).
   */
  signingKey?: string;
}

export class RedisCache implements Cache {
  private client: RedisLike;
  private keyPrefix: string;
  private tagPrefix: string;
  private packr = new Packr({ moreTypes: true });
  private signingKey?: Buffer;

  constructor(opts: RedisCacheOptions) {
    this.client = opts.client;
    this.keyPrefix = opts.keyPrefix ?? "";
    this.tagPrefix = opts.tagPrefix ?? "tag:";
    if (opts.signingKey) {
      if (opts.signingKey.length < 32) {
        throw new Error("RedisCache: signingKey must be at least 32 characters");
      }
      this.signingKey = Buffer.from(opts.signingKey, "utf8");
    }
  }

  private k(key: string): string {
    return this.keyPrefix + key;
  }

  private t(tag: string): string {
    return this.keyPrefix + this.tagPrefix + tag;
  }

  /**
   * Wrap raw msgpackr bytes with the F14 signed frame when signing is
   * enabled. The MAC binds the value to the namespaced key — an
   * attacker who steals one key's signed payload cannot replay it
   * under a different key.
   */
  private frame(namespacedKey: string, payload: Buffer): Buffer {
    if (!this.signingKey) return payload;
    const mac = createHmac("sha256", this.signingKey)
      .update(namespacedKey)
      .update(payload)
      .digest();
    return Buffer.concat([Buffer.from([FRAME_SIGNED_V1]), mac, payload]);
  }

  /**
   * Unwrap a signed frame, verifying the MAC. Returns `null` (and
   * fires a fire-and-forget delete of the offending key) on any
   * mismatch — frame byte unrecognized, MAC truncated, MAC fails to
   * verify, or signing was enabled but the value is unsigned (a
   * pre-signing entry or a tampering attempt). When signing is
   * disabled, returns the buffer as-is.
   */
  private unframe(namespacedKey: string, buf: Buffer): Buffer | null {
    if (!this.signingKey) return buf;
    if (buf.length < 1 + MAC_LENGTH) {
      this.dropPoisoned(namespacedKey);
      return null;
    }
    if (buf[0] !== FRAME_SIGNED_V1) {
      this.dropPoisoned(namespacedKey);
      return null;
    }
    const mac = buf.subarray(1, 1 + MAC_LENGTH);
    const payload = buf.subarray(1 + MAC_LENGTH);
    const expected = createHmac("sha256", this.signingKey)
      .update(namespacedKey)
      .update(payload)
      .digest();
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
      this.dropPoisoned(namespacedKey);
      return null;
    }
    return payload;
  }

  /**
   * Best-effort delete of a poisoned entry. Run in the background so
   * a failure (or a Redis hiccup) doesn't shadow the caller's
   * read-returns-null semantics.
   */
  private dropPoisoned(namespacedKey: string): void {
    void this.client.del(namespacedKey).catch(() => undefined);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const namespacedKey = this.k(key);
    const buf = await this.client.getBuffer(namespacedKey);
    if (buf === null) return null;
    const unframed = this.unframe(namespacedKey, buf);
    if (unframed === null) return null;
    return this.packr.unpack(unframed) as T;
  }

  async setIfAbsent<T = unknown>(
    key: string,
    value: T,
    opts: { ttlSec?: number } = {},
  ): Promise<boolean> {
    const namespacedKey = this.k(key);
    const payload = this.frame(namespacedKey, this.packr.pack(value));
    const args: unknown[] = ["NX"];
    if (opts.ttlSec !== undefined && opts.ttlSec > 0) {
      args.push("EX", opts.ttlSec);
    }
    const result = await this.client.set(namespacedKey, payload, ...args);
    // Real ioredis returns "OK" on success or null when the NX guard rejected.
    return result === "OK";
  }

  async set<T = unknown>(key: string, value: T, opts: CacheSetOptions = {}): Promise<void> {
    const namespacedKey = this.k(key);
    const payload = this.frame(namespacedKey, this.packr.pack(value));
    if (opts.ttlSec !== undefined && opts.ttlSec > 0) {
      await this.client.set(namespacedKey, payload, "EX", opts.ttlSec);
    } else {
      await this.client.set(namespacedKey, payload);
    }

    if (opts.tags && opts.tags.length > 0) {
      for (const tag of opts.tags) {
        const tagKey = this.t(tag);
        await this.client.sadd(tagKey, namespacedKey);
        // Match the value's TTL so tag bookkeeping doesn't outlive the data.
        if (opts.ttlSec !== undefined && opts.ttlSec > 0) {
          await this.client.expire(tagKey, opts.ttlSec);
        }
      }
    }
  }

  async del(key: string | readonly string[]): Promise<void> {
    const keys = (Array.isArray(key) ? key : [key as string]).map((k) => this.k(k));
    if (keys.length === 0) return;
    await this.client.del(...keys);
  }

  async invalidateTag(tag: string): Promise<void> {
    const tagKey = this.t(tag);
    const members = await this.client.smembers(tagKey);
    if (members.length > 0) {
      await this.client.del(...members);
    }
    await this.client.del(tagKey);
  }
}
