import {
  argon2 as argon2Callback,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

interface Argon2idParameters {
  readonly message: Buffer;
  readonly nonce: Uint8Array;
  readonly parallelism: number;
  readonly tagLength: number;
  readonly memory: number;
  readonly passes: number;
  readonly version: number;
}

function argon2id(parameters: Argon2idParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2Callback("argon2id", parameters, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function scrypt(
  password: Buffer,
  salt: Uint8Array,
  keyLength: number,
  options: { readonly N: number; readonly r: number; readonly p: number; readonly maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/**
 * Hashes and verifies passwords. The default is argon2id from `node:crypto`
 * (`argon2idPasswordHasher`); `scryptPasswordHasher` remains available. Both
 * have zero native dependencies.
 */
export interface PasswordHasher {
  readonly algorithm: string;
  hash(password: string): Promise<string>;
  /** Constant-time comparison against a stored hash; never throws on a malformed hash. */
  verify(password: string, stored: string): Promise<boolean>;
  /** True when `stored` was produced with weaker parameters than the current ones. */
  needsRehash(stored: string): boolean;
}

export interface ScryptPasswordHasherOptions {
  /** log2 of the CPU/memory cost `N`. Defaults to 15 (N = 32768, about 32 MiB). */
  readonly logCost?: number;
  /** Block size `r`. Defaults to 8. */
  readonly blockSize?: number;
  /** Parallelization `p`. Defaults to 1. */
  readonly parallelism?: number;
  /** Derived key length in bytes. Defaults to 32. */
  readonly keyLength?: number;
  /** Salt length in bytes. Defaults to 16. */
  readonly saltLength?: number;
}

const SCRYPT_PATTERN = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/u;

/**
 * scrypt (RFC 7914) with a PHC-style string: `$scrypt$ln=15,r=8,p=1$<salt>$<hash>`,
 * base64url without padding. The parameters travel with the hash so they can
 * be raised later and old hashes detected through `needsRehash`.
 */
export function scryptPasswordHasher(options: ScryptPasswordHasherOptions = {}): PasswordHasher {
  const logCost = options.logCost ?? 15;
  const blockSize = options.blockSize ?? 8;
  const parallelism = options.parallelism ?? 1;
  const keyLength = options.keyLength ?? 32;
  const saltLength = options.saltLength ?? 16;
  for (const [name, value, min, max] of [
    ["logCost", logCost, 10, 20],
    ["blockSize", blockSize, 1, 32],
    ["parallelism", parallelism, 1, 16],
    ["keyLength", keyLength, 16, 128],
    ["saltLength", saltLength, 8, 64],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TypeError(`scrypt ${name} must be an integer between ${min} and ${max}`);
    }
  }
  const cost = 2 ** logCost;
  const maxmem = 128 * cost * blockSize * parallelism + 1024 * 1024;

  const derive = async (
    password: string,
    salt: Uint8Array,
    parameters: { readonly N: number; readonly r: number; readonly p: number },
    length: number,
  ): Promise<Uint8Array> => {
    const key = await scrypt(Buffer.from(password, "utf8"), salt, length, {
      ...parameters,
      maxmem: 128 * parameters.N * parameters.r * parameters.p + 1024 * 1024,
    });
    return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
  };

  return Object.freeze({
    algorithm: "scrypt",
    async hash(password: string): Promise<string> {
      const salt = randomBytes(saltLength);
      const key = await derive(
        password,
        salt,
        { N: cost, r: blockSize, p: parallelism },
        keyLength,
      );
      return `$scrypt$ln=${logCost},r=${blockSize},p=${parallelism}$${base64url(salt)}$${base64url(key)}`;
    },
    async verify(password: string, stored: string): Promise<boolean> {
      const parsed = parseScrypt(stored);
      if (!parsed) return false;
      if (128 * parsed.N * parsed.r * parsed.p > maxmem) return false;
      const key = await derive(
        password,
        parsed.salt,
        { N: parsed.N, r: parsed.r, p: parsed.p },
        parsed.hash.byteLength,
      );
      return key.byteLength === parsed.hash.byteLength && timingSafeEqual(key, parsed.hash);
    },
    needsRehash(stored: string): boolean {
      const parsed = parseScrypt(stored);
      if (!parsed) return true;
      return (
        parsed.N < cost ||
        parsed.r < blockSize ||
        parsed.p < parallelism ||
        parsed.hash.byteLength < keyLength
      );
    },
  });
}

function parseScrypt(stored: string) {
  if (typeof stored !== "string") return undefined;
  const match = SCRYPT_PATTERN.exec(stored);
  if (!match) return undefined;
  const ln = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isInteger(ln) || ln < 1 || ln > 30 || !Number.isInteger(r) || !Number.isInteger(p)) {
    return undefined;
  }
  return {
    N: 2 ** ln,
    r,
    p,
    salt: fromBase64url(match[4] as string),
    hash: fromBase64url(match[5] as string),
  };
}

export interface Argon2idPasswordHasherOptions {
  /** Memory cost in KiB. Defaults to 65536 (64 MiB). */
  readonly memory?: number;
  /** Number of passes `t`. Defaults to 3. */
  readonly passes?: number;
  /** Parallelism `p`. Defaults to 1. */
  readonly parallelism?: number;
  /** Tag (derived key) length in bytes. Defaults to 32. */
  readonly tagLength?: number;
  /** Salt length in bytes. Defaults to 16. */
  readonly saltLength?: number;
}

const ARGON2_VERSION = 0x13;
const ARGON2_MAX_MEMORY = 1024 * 1024; // 1 GiB in KiB; a stored hash never asks for more
const ARGON2ID_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u;

/**
 * argon2id (RFC 9106) from `node:crypto` with the standard PHC string
 * `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>` (base64 without padding), so
 * hashes are portable to and from other argon2 implementations. The defaults
 * (64 MiB, three passes) sit above the OWASP minimum of 19 MiB and two passes.
 *
 * `verify` also accepts a `$scrypt$` string produced by `scryptPasswordHasher`
 * and `needsRehash` reports it, so a deployment that started on scrypt
 * upgrades every account on its next successful sign-in with no migration.
 */
export function argon2idPasswordHasher(
  options: Argon2idPasswordHasherOptions = {},
): PasswordHasher {
  const memory = options.memory ?? 65536;
  const passes = options.passes ?? 3;
  const parallelism = options.parallelism ?? 1;
  const tagLength = options.tagLength ?? 32;
  const saltLength = options.saltLength ?? 16;
  for (const [name, value, min, max] of [
    ["memory", memory, 8, ARGON2_MAX_MEMORY],
    ["passes", passes, 1, 10],
    ["parallelism", parallelism, 1, 16],
    ["tagLength", tagLength, 16, 128],
    ["saltLength", saltLength, 8, 64],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TypeError(`argon2id ${name} must be an integer between ${min} and ${max}`);
    }
  }
  if (memory < 8 * parallelism) {
    throw new TypeError("argon2id memory must be at least 8 KiB per lane of parallelism");
  }
  const legacy = scryptPasswordHasher();

  const derive = (
    password: string,
    salt: Uint8Array,
    parameters: { readonly memory: number; readonly passes: number; readonly parallelism: number },
    length: number,
  ): Promise<Buffer> =>
    argon2id({
      message: Buffer.from(password, "utf8"),
      nonce: salt,
      memory: parameters.memory,
      passes: parameters.passes,
      parallelism: parameters.parallelism,
      tagLength: length,
      version: ARGON2_VERSION,
    });

  return Object.freeze({
    algorithm: "argon2id",
    async hash(password: string): Promise<string> {
      const salt = randomBytes(saltLength);
      const key = await derive(password, salt, { memory, passes, parallelism }, tagLength);
      return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${base64(salt)}$${base64(key)}`;
    },
    async verify(password: string, stored: string): Promise<boolean> {
      if (typeof stored === "string" && stored.startsWith("$scrypt$")) {
        return legacy.verify(password, stored);
      }
      const parsed = parseArgon2id(stored);
      if (!parsed) return false;
      const key = await derive(password, parsed.salt, parsed, parsed.hash.byteLength);
      return key.byteLength === parsed.hash.byteLength && timingSafeEqual(key, parsed.hash);
    },
    needsRehash(stored: string): boolean {
      const parsed = parseArgon2id(stored);
      if (!parsed) return true;
      return (
        parsed.memory < memory ||
        parsed.passes < passes ||
        parsed.parallelism < parallelism ||
        parsed.hash.byteLength < tagLength
      );
    },
  });
}

function parseArgon2id(stored: string) {
  if (typeof stored !== "string") return undefined;
  const match = ARGON2ID_PATTERN.exec(stored);
  if (!match) return undefined;
  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  if (
    !Number.isInteger(memory) ||
    memory < 8 ||
    memory > ARGON2_MAX_MEMORY ||
    !Number.isInteger(passes) ||
    passes < 1 ||
    passes > 10 ||
    !Number.isInteger(parallelism) ||
    parallelism < 1 ||
    parallelism > 16
  ) {
    return undefined;
  }
  const salt = fromBase64(match[4] as string);
  const hash = fromBase64(match[5] as string);
  if (salt.byteLength < 8 || hash.byteLength < 16) return undefined;
  return { memory, passes, parallelism, salt, hash };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/u, "");
}

function fromBase64(value: string): Uint8Array {
  const buffer = Buffer.from(value, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64url(value: string): Uint8Array {
  const buffer = Buffer.from(value, "base64url");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
