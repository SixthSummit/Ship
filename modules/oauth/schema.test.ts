import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizationHeader,
  isActive,
  isExpired,
  isExpiringSoon,
  needsRefresh,
  type OAuthConnection,
} from "./schema.js";

const FIXED_NOW = new Date("2025-01-01T12:00:00Z").getTime();

describe("oauth schema status helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isExpired", () => {
    it("false when expiresAt is null (no expiry tracking)", () => {
      expect(isExpired({ expiresAt: null } as unknown as OAuthConnection)).toBe(false);
    });

    it("false when expiresAt is in the future", () => {
      expect(isExpired({ expiresAt: new Date(FIXED_NOW + 60_000) })).toBe(false);
    });

    it("true when expiresAt is in the past", () => {
      expect(isExpired({ expiresAt: new Date(FIXED_NOW - 60_000) })).toBe(true);
    });

    it("true exactly at the expiry instant", () => {
      expect(isExpired({ expiresAt: new Date(FIXED_NOW) })).toBe(true);
    });
  });

  describe("isExpiringSoon", () => {
    it("false when expiresAt is null", () => {
      expect(isExpiringSoon({ expiresAt: null } as unknown as OAuthConnection)).toBe(false);
    });

    it("true when expiry is within the 5-minute window", () => {
      expect(isExpiringSoon({ expiresAt: new Date(FIXED_NOW + 4 * 60_000) })).toBe(true);
    });

    it("true at exactly 5 minutes out (boundary inclusive)", () => {
      expect(isExpiringSoon({ expiresAt: new Date(FIXED_NOW + 5 * 60_000) })).toBe(true);
    });

    it("false when expiry is more than 5 minutes out", () => {
      expect(isExpiringSoon({ expiresAt: new Date(FIXED_NOW + 6 * 60_000) })).toBe(false);
    });

    it("true when already expired (the window covers the past too)", () => {
      expect(isExpiringSoon({ expiresAt: new Date(FIXED_NOW - 60_000) })).toBe(true);
    });
  });

  describe("isActive", () => {
    it("false when no access token", () => {
      expect(isActive({ accessToken: null, expiresAt: new Date(FIXED_NOW + 60_000) })).toBe(false);
    });

    it("false when access token present but expired", () => {
      expect(
        isActive({
          accessToken: "tok",
          expiresAt: new Date(FIXED_NOW - 60_000),
        }),
      ).toBe(false);
    });

    it("true when access token present and not expired", () => {
      expect(
        isActive({
          accessToken: "tok",
          expiresAt: new Date(FIXED_NOW + 60_000),
        }),
      ).toBe(true);
    });

    it("true when access token present and no expiry tracking (null expiresAt)", () => {
      expect(isActive({ accessToken: "tok", expiresAt: null } as unknown as OAuthConnection)).toBe(
        true,
      );
    });
  });

  describe("needsRefresh", () => {
    it("true when expired", () => {
      expect(needsRefresh({ expiresAt: new Date(FIXED_NOW - 60_000) })).toBe(true);
    });

    it("true when expiring soon (≤ 5 min)", () => {
      expect(needsRefresh({ expiresAt: new Date(FIXED_NOW + 60_000) })).toBe(true);
    });

    it("false when expiry is comfortably in the future", () => {
      expect(needsRefresh({ expiresAt: new Date(FIXED_NOW + 60 * 60_000) })).toBe(false);
    });
  });

  describe("authorizationHeader", () => {
    it("null when no access token", () => {
      expect(authorizationHeader({ accessToken: null, tokenType: null })).toBeNull();
    });

    it("formats as `<type> <token>` when type is set", () => {
      expect(authorizationHeader({ accessToken: "abc", tokenType: "Bearer" })).toBe("Bearer abc");
    });

    it("defaults to `Bearer` when tokenType is null", () => {
      expect(authorizationHeader({ accessToken: "abc", tokenType: null })).toBe("Bearer abc");
    });
  });
});
