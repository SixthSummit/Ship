import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

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
 * Hashes and verifies passwords. The default is scrypt from `node:crypto`
 * (zero native dependencies); bind an argon2id implementation here when the
 * deployment can carry a native binding.
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

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64url(value: string): Uint8Array {
  const buffer = Buffer.from(value, "base64url");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
