import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  concatBytes,
  constantTimeEqual,
  digest,
  hexToBytes,
  hmac,
  isWithinTolerance,
  unixSecondsToDate,
  utf8Bytes,
  utf8Text,
} from "./webhook-crypto.js";

describe("webhook crypto helpers", () => {
  it("round-trips hex and base64 and rejects malformed encodings", () => {
    const bytes = new Uint8Array([0, 1, 254, 255, 16]);
    expect(bytesToHex(bytes)).toBe("0001feff10");
    expect(hexToBytes("0001feff10")).toEqual(bytes);
    expect(hexToBytes("abc")).toBeUndefined();
    expect(hexToBytes("zz")).toBeUndefined();
    expect(bytesToBase64(bytes)).toBe("AAH+/xA=");
    expect(base64ToBytes("AAH+/xA=")).toEqual(bytes);
    expect(base64ToBytes("AAH+/xA")).toBeUndefined();
    expect(base64ToBytes("!!!!")).toBeUndefined();
  });

  it("compares in constant time across equal and unequal lengths", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });

  it("computes HMAC and digests with WebCrypto matching known vectors", async () => {
    // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
    expect(bytesToHex(await hmac("SHA-256", "Jefe", "what do ya want for nothing?"))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    expect(bytesToHex(await hmac("SHA-1", utf8Bytes("Jefe"), "what do ya want for nothing?"))).toBe(
      "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79",
    );
    expect(bytesToHex(await digest("SHA-256", "abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(bytesToHex(await digest("SHA-256", utf8Bytes("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("decodes UTF-8 strictly and concatenates byte views", () => {
    expect(utf8Text(utf8Bytes("héllo"))).toBe("héllo");
    expect(() => utf8Text(new Uint8Array([0xff, 0xfe]))).toThrow();
    expect(concatBytes(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("parses provider timestamps and applies tolerance", () => {
    expect(unixSecondsToDate("1700000000")).toEqual(new Date(1_700_000_000_000));
    expect(unixSecondsToDate("-1")).toBeUndefined();
    expect(unixSecondsToDate("17e5")).toBeUndefined();
    expect(unixSecondsToDate(undefined)).toBeUndefined();
    const now = new Date(1_700_000_000_000);
    expect(isWithinTolerance(new Date(now.getTime() - 299_000), now, 300_000)).toBe(true);
    expect(isWithinTolerance(new Date(now.getTime() + 301_000), now, 300_000)).toBe(false);
  });
});
