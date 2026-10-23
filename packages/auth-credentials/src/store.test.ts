import { beforeEach, describe, expect, it } from "vitest";
import { credentialStoreConformance } from "./conformance.js";
import { createInMemoryCredentialStore } from "./memory-store.js";
import { isCredentialStore } from "./store.js";

credentialStoreConformance(
  "in-memory",
  { create: () => createInMemoryCredentialStore() },
  { describe, it, beforeEach, expect },
);

describe("isCredentialStore", () => {
  it("recognises the in-memory store and refuses partial objects", () => {
    expect(isCredentialStore(createInMemoryCredentialStore())).toBe(true);
    expect(isCredentialStore({ kind: "ship.credential-store", adapter: "x" })).toBe(false);
    expect(isCredentialStore(null)).toBe(false);
  });
});
