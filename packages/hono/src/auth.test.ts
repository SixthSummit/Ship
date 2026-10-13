import { describe, expect, it } from "vitest";
import { defineHonoCredentialAdapter, requestHeadersCredential } from "./auth.js";

describe("Hono credential adapters", () => {
  it("extracts an immutable lower-case header credential", async () => {
    const adapter = requestHeadersCredential();
    const credential = await adapter.extract(
      new Request("https://example.test", {
        headers: { Authorization: "Bearer token", "X-Custom": "value" },
      }),
    );

    expect(credential).toMatchObject({ authorization: "Bearer token", "x-custom": "value" });
    expect(Object.isFrozen(credential)).toBe(true);
    expect(Object.isFrozen(adapter)).toBe(true);
  });

  it("preserves a custom credential type and validates untyped declarations", async () => {
    const adapter = defineHonoCredentialAdapter({
      id: "http.bearer",
      extract: (request) => request.headers.get("authorization")?.replace(/^Bearer /u, ""),
    });

    await expect(
      Promise.resolve(
        adapter.extract(
          new Request("https://example.test", { headers: { authorization: "Bearer x" } }),
        ),
      ),
    ).resolves.toBe("x");
    const define = defineHonoCredentialAdapter as (adapter: unknown) => unknown;
    expect(() => define({ id: "Bad Adapter", extract: () => undefined })).toThrow(TypeError);
    expect(() => define({ id: "http.bearer" })).toThrow(TypeError);
  });
});
