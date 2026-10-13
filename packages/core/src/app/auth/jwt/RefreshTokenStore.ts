import { createHash, randomBytes } from "node:crypto";

/**
 * `RefreshTokenStore` — abstract persistence for refresh-token rotation.
 *
 * The auth flow stores a SHA-256 *hash* of every issued refresh token. The
 * raw token leaves the server only once (in the response cookie); subsequent
 * requests recompute the hash and look up the row. This means even a full
 * database compromise does not let an attacker mint or replay refresh tokens
 * — they would still need the raw cookie value.
 *
 * Reuse detection is the load-bearing security property: when a refresh
 * token is consumed (`consume()`), the row's `replacedById` is set to the
 * successor's ID. If a token is presented whose row already has
 * `replacedById` set, it has been used before — a strong signal of theft.
 * The auth flow's response is to revoke the entire chain (`revokeChain()`)
 * so neither the legitimate user nor the attacker can keep refreshing.
 */

/**
 * Stored representation of a refresh token. Implementations may add fields,
 * but the framework only depends on these.
 */
export interface RefreshTokenRecord {
  id: string;
  accountId: string;
  /** SHA-256 hex digest of the raw token. Never stores the raw token itself. */
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  /** Successor's ID when this token has been rotated; null otherwise. */
  replacedById: string | null;
  userAgent?: string | null;
  issuedFromIp?: string | null;
}

export interface IssueRefreshTokenInput {
  accountId: string;
  /** Pre-computed SHA-256 hex digest. Computed by the auth flow. */
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string;
  issuedFromIp?: string;
}

export interface RefreshTokenStore {
  /** Persist a newly minted refresh token. Returns the stored record's ID. */
  issue(input: IssueRefreshTokenInput): Promise<RefreshTokenRecord>;

  /** Look up a token by its hash. Returns `null` if absent. */
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;

  /**
   * Atomically rotate: mark the old row's `replacedById` and persist the
   * new row. Implementations MUST do this in a single transaction so a
   * crash between the two writes can't lose the link.
   */
  rotate(oldId: string, newToken: IssueRefreshTokenInput): Promise<RefreshTokenRecord>;

  /** Mark a single token revoked (e.g., on logout). */
  revoke(id: string): Promise<void>;

  /**
   * Revoke an entire rotation chain — every ancestor and every descendant.
   * Triggered on reuse detection (a strong signal of stolen tokens).
   */
  revokeChain(id: string): Promise<number>;

  /**
   * Revoke every active token for an account — e.g., on password reset or
   * "sign out everywhere". Returns the number of rows revoked.
   */
  revokeAllForAccount(accountId: string): Promise<number>;
}

/**
 * Compute the SHA-256 digest of a raw refresh token. Hex-encoded so it fits
 * the `varchar(128)` column on `refresh_tokens.token_hash` exactly.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Generate a cryptographically random refresh-token string. 32 random bytes
 * (256 bits) base64url-encoded — opaque to clients, indistinguishable from
 * a UUID. Not a JWT: refresh tokens have no payload of their own; the row
 * in `refresh_tokens` carries all the metadata.
 */
export function generateRefreshTokenValue(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * In-memory implementation for tests and dev. Implementations MUST keep the
 * full chain reachable so `revokeChain` can walk both directions.
 */
export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private byId = new Map<string, RefreshTokenRecord>();
  private byHash = new Map<string, string>();
  private idCounter = 0;

  async issue(input: IssueRefreshTokenInput): Promise<RefreshTokenRecord> {
    const id = this.nextId();
    const record: RefreshTokenRecord = {
      id,
      accountId: input.accountId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      replacedById: null,
      userAgent: input.userAgent ?? null,
      issuedFromIp: input.issuedFromIp ?? null,
    };
    this.byId.set(id, record);
    this.byHash.set(input.tokenHash, id);
    return record;
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const id = this.byHash.get(tokenHash);
    if (!id) return null;
    return this.byId.get(id) ?? null;
  }

  async rotate(oldId: string, newToken: IssueRefreshTokenInput): Promise<RefreshTokenRecord> {
    const old = this.byId.get(oldId);
    if (!old) throw new Error(`RefreshTokenStore: cannot rotate unknown id ${oldId}`);
    const newRecord = await this.issue(newToken);
    old.replacedById = newRecord.id;
    return newRecord;
  }

  async revoke(id: string): Promise<void> {
    const row = this.byId.get(id);
    if (!row) return;
    if (!row.revokedAt) row.revokedAt = new Date();
  }

  async revokeChain(id: string): Promise<number> {
    const visited = new Set<string>();
    let count = 0;

    // Walk forward via replacedById.
    let cursor: string | null = id;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const row = this.byId.get(cursor);
      if (!row) break;
      if (!row.revokedAt) {
        row.revokedAt = new Date();
        count += 1;
      }
      cursor = row.replacedById;
    }

    // Walk backward by scanning for predecessors. Cheap on small in-memory
    // sets; the Drizzle implementation does it with a recursive CTE.
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of this.byId.values()) {
        if (row.replacedById && visited.has(row.replacedById) && !visited.has(row.id)) {
          visited.add(row.id);
          if (!row.revokedAt) {
            row.revokedAt = new Date();
            count += 1;
          }
          changed = true;
        }
      }
    }

    return count;
  }

  async revokeAllForAccount(accountId: string): Promise<number> {
    let count = 0;
    for (const row of this.byId.values()) {
      if (row.accountId === accountId && !row.revokedAt) {
        row.revokedAt = new Date();
        count += 1;
      }
    }
    return count;
  }

  /** Test helper. */
  size(): number {
    return this.byId.size;
  }

  /** Test helper. */
  clear(): void {
    this.byId.clear();
    this.byHash.clear();
    this.idCounter = 0;
  }

  private nextId(): string {
    this.idCounter += 1;
    return `mem-${this.idCounter}`;
  }
}
