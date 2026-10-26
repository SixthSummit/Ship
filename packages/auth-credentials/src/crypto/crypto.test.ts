import { describe, expect, it } from "vitest";
import { argon2idPasswordHasher, scryptPasswordHasher } from "./password.js";
import { createSecretBox } from "./secretbox.js";
import {
  generateRecoveryCode,
  generateToken,
  hashRecoveryCode,
  hashToken,
  isTokenShaped,
  normalizeRecoveryCode,
  SESSION_TOKEN_PREFIX,
} from "./tokens.js";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  totpStep,
  verifyTotp,
} from "./totp.js";

describe("scryptPasswordHasher", () => {
  const hasher = scryptPasswordHasher({ logCost: 10 });

  it("hashes with a PHC string carrying its parameters and verifies in constant time", async () => {
    const stored = await hasher.hash("correct horse battery staple");
    expect(stored).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u);
    expect(await hasher.verify("correct horse battery staple", stored)).toBe(true);
    expect(await hasher.verify("correct horse battery stapl", stored)).toBe(false);
    expect(await hasher.verify("anything", "not-a-hash")).toBe(false);
    expect(await hasher.verify("anything", "$scrypt$ln=99,r=8,p=1$abc$def")).toBe(false);
  });

  it("salts every hash and reports when parameters were raised", async () => {
    const first = await hasher.hash("same");
    const second = await hasher.hash("same");
    expect(first).not.toBe(second);
    expect(hasher.needsRehash(first)).toBe(false);
    expect(scryptPasswordHasher({ logCost: 11 }).needsRehash(first)).toBe(true);
    expect(hasher.needsRehash("garbage")).toBe(true);
    expect(await scryptPasswordHasher({ logCost: 11 }).verify("same", first)).toBe(true);
  });

  it("rejects parameters outside the safe range", () => {
    expect(() => scryptPasswordHasher({ logCost: 9 })).toThrow(TypeError);
    expect(() => scryptPasswordHasher({ keyLength: 8 })).toThrow(TypeError);
  });
});

describe("argon2idPasswordHasher", () => {
  const hasher = argon2idPasswordHasher({ memory: 1024, passes: 1 });

  it("hashes with the standard PHC string and verifies in constant time", async () => {
    const stored = await hasher.hash("correct horse battery staple");
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/u);
    expect(await hasher.verify("correct horse battery staple", stored)).toBe(true);
    expect(await hasher.verify("wrong", stored)).toBe(false);
    expect(await hasher.verify("anything", "not a hash")).toBe(false);
    expect(
      await hasher.verify(
        "anything",
        "$argon2id$v=19$m=99999999,t=1,p=1$abcdefghijk$abcdefghijklmnopqrstuv",
      ),
    ).toBe(false);
    expect(hasher.needsRehash(stored)).toBe(false);
  });

  it("verifies a legacy scrypt hash and asks for a rehash", async () => {
    const legacy = await scryptPasswordHasher({ logCost: 10 }).hash("same");
    expect(await hasher.verify("same", legacy)).toBe(true);
    expect(await hasher.verify("other", legacy)).toBe(false);
    expect(hasher.needsRehash(legacy)).toBe(true);
  });

  it("salts every hash and reports when parameters were raised", async () => {
    const first = await hasher.hash("same");
    const second = await hasher.hash("same");
    expect(first).not.toBe(second);
    expect(argon2idPasswordHasher({ memory: 2048, passes: 1 }).needsRehash(first)).toBe(true);
    expect(argon2idPasswordHasher({ memory: 1024, passes: 2 }).needsRehash(first)).toBe(true);
    expect(await argon2idPasswordHasher({ memory: 2048, passes: 2 }).verify("same", first)).toBe(
      true,
    );
  });

  it("rejects parameters outside the safe range", () => {
    expect(() => argon2idPasswordHasher({ memory: 4 })).toThrow(TypeError);
    expect(() => argon2idPasswordHasher({ passes: 0 })).toThrow(TypeError);
    expect(() => argon2idPasswordHasher({ tagLength: 8 })).toThrow(TypeError);
    expect(() => argon2idPasswordHasher({ memory: 16, parallelism: 4 })).toThrow(TypeError);
  });

  it("uses the OWASP-or-better defaults", async () => {
    const stored = await argon2idPasswordHasher().hash("default parameters");
    expect(stored.startsWith("$argon2id$v=19$m=65536,t=3,p=1$")).toBe(true);
  });
});

describe("totp", () => {
  // RFC 6238 appendix B test vectors (SHA-1, 8 digits, secret "12345678901234567890").
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
  const vectors: readonly (readonly [number, string])[] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(vectors)("matches RFC 6238 at t=%d", (seconds, expected) => {
    const step = totpStep(new Date(seconds * 1000));
    expect(totpCode(secret, step, { digits: 8 })).toBe(expected);
  });

  it("verifies within the drift window and refuses a replayed step", () => {
    const now = new Date(1111111111 * 1000);
    const step = totpStep(now);
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, code, { now })).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), { now })).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 2), { now })).toBeUndefined();
    expect(verifyTotp(secret, totpCode(secret, step + 2), { now, window: 2 })).toBe(step + 2);
    expect(verifyTotp(secret, code, { now, lastUsedStep: step })).toBeUndefined();
    expect(verifyTotp(secret, "12345", { now })).toBeUndefined();
    expect(verifyTotp(secret, "abcdef", { now })).toBeUndefined();
  });

  it("round-trips base32 and builds an otpauth URI", () => {
    const generated = generateTotpSecret();
    expect(generated).toMatch(/^[A-Z2-7]{32}$/u);
    expect(base32Encode(base32Decode(generated))).toBe(generated);
    expect(() => base32Decode("not base32!")).toThrow(TypeError);
    const url = otpauthUrl({ issuer: "Ship App", account: "ada@example.test", secret: generated });
    expect(url).toBe(
      `otpauth://totp/Ship%20App:ada%40example.test?secret=${generated}&issuer=Ship+App&algorithm=SHA1&digits=6&period=30`,
    );
  });
});

describe("tokens", () => {
  it("generates prefixed 256-bit tokens and hashes them for storage", () => {
    const token = generateToken(SESSION_TOKEN_PREFIX);
    expect(isTokenShaped(token, SESSION_TOKEN_PREFIX)).toBe(true);
    expect(isTokenShaped(`${token}x`, SESSION_TOKEN_PREFIX)).toBe(false);
    expect(isTokenShaped(token, "ship_c_")).toBe(false);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("normalises recovery codes before hashing", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[a-hj-kmnp-z2-9]{5}(?:-[a-hj-kmnp-z2-9]{5}){3}$/u);
    expect(normalizeRecoveryCode(code.toUpperCase().replaceAll("-", " "))).toBe(code);
    expect(hashRecoveryCode(code.toUpperCase())).toBe(hashRecoveryCode(code));
  });
});

describe("createSecretBox", () => {
  const ring = {
    current: "k2",
    keys: {
      k1: "00".repeat(32),
      k2: Buffer.alloc(32, 7).toString("base64"),
    },
  };

  it("encrypts under the current key and decrypts under any key in the ring", () => {
    const box = createSecretBox(ring);
    const sealed = box.encrypt("JBSWY3DPEHPK3PXP");
    expect(sealed.startsWith("v1.k2.")).toBe(true);
    expect(box.keyIdOf(sealed)).toBe("k2");
    expect(box.decrypt(sealed)).toBe("JBSWY3DPEHPK3PXP");
    const old = createSecretBox({ current: "k1", keys: ring.keys }).encrypt("secret");
    expect(box.decrypt(old)).toBe("secret");
    expect(box.keyIdOf("garbage")).toBeUndefined();
  });

  it("refuses tampering and unknown keys", () => {
    const box = createSecretBox(ring);
    const sealed = box.encrypt("secret");
    const tampered = sealed.replace(/\.[^.]+$/u, ".AAAAAAAAAAAAAAAAAAAAAA");
    expect(() => box.decrypt(tampered)).toThrow();
    expect(() => box.decrypt(sealed.replace("v1.k2.", "v1.k9."))).toThrow(TypeError);
    expect(() => box.decrypt("nope")).toThrow(TypeError);
  });

  it("validates the ring at definition time", () => {
    expect(() => createSecretBox({ current: "k1", keys: {} })).toThrow(/not in the key ring/u);
    expect(() => createSecretBox({ current: "k1", keys: { k1: "abc" } })).toThrow(/32 bytes/u);
    expect(() =>
      createSecretBox({ current: "bad id!", keys: { "bad id!": "00".repeat(32) } }),
    ).toThrow(/key id/u);
  });
});
