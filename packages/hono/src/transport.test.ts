import {
  ApplicationCompilationError,
  defineApp,
  defineModule,
  defineOperation,
  publicAccess,
} from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { http, InvalidHttpTransportError, isHttpTransport } from "./transport.js";

describe("http transport declarations", () => {
  it.each([
    ["GET", http.get("/fixtures/:fixtureId")],
    ["POST", http.post("/fixtures")],
    ["PUT", http.put("/fixtures/:fixtureId")],
    ["PATCH", http.patch("/fixtures/:fixtureId")],
    ["DELETE", http.delete("/fixtures/:fixtureId")],
    ["OPTIONS", http.options("/fixtures")],
  ] as const)("creates an immutable %s binding", (method, transport) => {
    expect(transport).toEqual({
      kind: "http",
      binding: `${method} ${transport.metadata.path}`,
      metadata: {
        method,
        path: transport.metadata.path,
        response: "json",
        contentType: "application/json; charset=UTF-8",
        requestBody: { mode: "json" },
      },
    });
    expect(isHttpTransport(transport)).toBe(true);
    expect(Object.isFrozen(transport)).toBe(true);
    expect(Object.isFrozen(transport.metadata)).toBe(true);
  });

  it("supports a generic route helper without widening method or path literals", () => {
    const transport = http.route("POST", "/commands/:commandId");

    expect(transport.binding).toBe("POST /commands/:commandId");
  });

  it("declares first-value query parsing explicitly and rejects unknown modes", () => {
    const transport = http.get("/callback", { response: "redirect", queryParsing: "first-value" });
    expect(transport.metadata.queryParsing).toBe("first-value");
    expect(isHttpTransport(transport)).toBe(true);
    expect(() => http.get("/callback", { queryParsing: "last-value" as "strict" })).toThrow(
      InvalidHttpTransportError,
    );
    expect(
      isHttpTransport({
        ...transport,
        metadata: { ...transport.metadata, queryParsing: "last-value" },
      } as typeof transport),
    ).toBe(false);
  });

  it("declares literal repeated query keys without bracket interpretation", () => {
    expect(http.get("/lookup", { queryParsing: "literal-keys" }).metadata.queryParsing).toBe(
      "literal-keys",
    );
  });

  it.each([
    ["json", http.get("/json"), "application/json; charset=UTF-8"],
    ["text", http.get("/text", { response: "text" }), "text/plain; charset=UTF-8"],
    [
      "binary",
      http.get("/download", { response: "binary", contentType: "application/pdf" }),
      "application/pdf",
    ],
  ] as const)("declares %s response representation", (response, transport, contentType) => {
    expect(transport.metadata).toMatchObject({ response, contentType });
  });

  it("declares redirect representations without a content type on every method", () => {
    const get = http.get("/oauth/callback", { response: "redirect" });
    const post = http.post("/forms/submit", { response: "redirect" });
    expect(get.metadata).toEqual({
      method: "GET",
      path: "/oauth/callback",
      response: "redirect",
      requestBody: { mode: "json" },
    });
    expect(post.metadata).toMatchObject({ method: "POST", response: "redirect" });
    expect(get.metadata).not.toHaveProperty("contentType");
    expect(isHttpTransport(get)).toBe(true);
    expect(isHttpTransport(post)).toBe(true);
    expect(Object.isFrozen(get.metadata)).toBe(true);
  });

  it("rejects redirect declarations that carry a content type", () => {
    expect(() =>
      http.get("/oauth/callback", { response: "redirect", contentType: "text/html" }),
    ).toThrow(InvalidHttpTransportError);
    expect(() =>
      http.get("/oauth/callback", {
        response: "redirect",
        contentTypes: ["text/html", "text/plain"],
      } as never),
    ).toThrow(InvalidHttpTransportError);
    const transport = http.get("/oauth/callback", { response: "redirect" });
    expect(
      isHttpTransport({
        ...transport,
        metadata: { ...transport.metadata, contentType: "text/html" },
      } as typeof transport),
    ).toBe(false);
  });

  it("declares immutable alternative binary content types", () => {
    const transport = http.get("/export", {
      response: "binary",
      contentTypes: [
        "text/csv; charset=utf-8",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    });
    expect(transport.metadata.contentType).toBe("text/csv; charset=utf-8");
    expect(transport.metadata.contentTypes).toHaveLength(2);
    expect(Object.isFrozen(transport.metadata.contentTypes)).toBe(true);
    expect(isHttpTransport(transport)).toBe(true);
  });

  it("declares immutable bounded JSON, raw, and multipart request bodies", () => {
    const json = http.body.json({ maxBytes: 128 });
    const permissiveJson = http.body.json({
      onNonJsonContentType: "ignore",
      onInvalidJson: "ignore",
      onEmptyJsonBody: "reject",
    });
    const raw = http.body.raw({ maxBytes: 256, contentTypes: ["Application/JSON"] });
    const multipart = http.body.multipart({
      maxBytes: 1024,
      maxFileBytes: 512,
      maxFiles: 2,
      maxFields: 3,
      maxFieldBytes: 64,
    });
    const fileOnly = http.body.multipart({
      maxBytes: 128,
      maxFileBytes: 64,
      maxFields: 0,
    });

    expect(json).toEqual({ mode: "json", maxBytes: 128 });
    expect(permissiveJson).toEqual({
      mode: "json",
      onNonJsonContentType: "ignore",
      onInvalidJson: "ignore",
      onEmptyJsonBody: "reject",
    });
    expect(Object.isFrozen(permissiveJson)).toBe(true);
    expect(raw).toEqual({ mode: "raw", maxBytes: 256, contentTypes: ["application/json"] });
    expect(multipart).toEqual({
      mode: "multipart",
      maxBytes: 1024,
      maxFiles: 2,
      maxFileBytes: 512,
      maxFields: 3,
      maxFieldBytes: 64,
    });
    expect(http.post("/raw", { requestBody: raw }).metadata.requestBody).toEqual(raw);
    expect(Object.isFrozen(raw.contentTypes)).toBe(true);
    expect(Object.isFrozen(multipart)).toBe(true);
    expect(fileOnly.maxFields).toBe(0);
  });

  it("projects method and path into the deterministic application graph", () => {
    const read = operation("fixtures.read", http.get("/fixtures/:fixtureId"));
    const module = defineModule({
      id: "fixtures",
      operations: [read],
      providers: [],
      imports: [],
      exports: [],
    });
    const application = defineApp({ id: "fixture-api", modules: [module] });

    expect(application.graph.operations[0].transport).toEqual({
      kind: "http",
      binding: "GET /fixtures/:fixtureId",
      metadata: {
        method: "GET",
        path: "/fixtures/:fixtureId",
        response: "json",
        contentType: "application/json; charset=UTF-8",
        requestBody: { mode: "json" },
      },
    });
    expect(Object.isFrozen(application.graph.operations[0].transport?.metadata)).toBe(true);
    expect(Object.isFrozen(application.graph.operations[0].transport?.metadata?.requestBody)).toBe(
      true,
    );
  });

  it.each([
    "fixtures",
    "/fixtures/",
    "/fixtures//next",
    "/fixtures?limit=1",
    "/fixtures#top",
    "/fixtures/:bad-name",
    "/fixtures/prefix:id",
    "/fixtures/:id/:id",
    "/fixtures/*",
  ])("rejects ambiguous or non-canonical path %j", (path) => {
    expect(() => http.get(path)).toThrow(InvalidHttpTransportError);
  });

  it("rejects invalid method and path values from untyped callers", () => {
    const route = http.route as (method: unknown, path: unknown, options?: unknown) => unknown;
    const rawBody = http.body.raw as (options: unknown) => unknown;

    expect(() => route("TRACE", "/fixtures")).toThrow(InvalidHttpTransportError);
    expect(() => route("GET", null)).toThrow(InvalidHttpTransportError);
    expect(() => route("GET", "/fixtures", { response: "raw" })).toThrow(InvalidHttpTransportError);
    expect(() => route("GET", "/fixtures", { contentType: "text/plain\r\nx-unsafe: 1" })).toThrow(
      InvalidHttpTransportError,
    );
    for (const options of [
      { response: "json", contentTypes: ["text/csv", "application/pdf"] },
      { response: "binary", contentTypes: ["text/csv"] },
      { response: "binary", contentTypes: ["text/csv", "TEXT/CSV"] },
      { response: "binary", contentTypes: ["text/csv", "text/plain\r\nx-unsafe: 1"] },
      {
        response: "binary",
        contentType: "text/csv",
        contentTypes: ["text/csv", "application/pdf"],
      },
    ]) {
      expect(() => route("GET", "/export", options)).toThrow(InvalidHttpTransportError);
    }
    expect(() => route("POST", "/fixtures", { requestBody: { mode: "raw" } })).toThrow(
      InvalidHttpTransportError,
    );
    expect(() =>
      route("POST", "/fixtures", {
        requestBody: { mode: "json", onNonJsonContentType: "coerce" },
      }),
    ).toThrow(InvalidHttpTransportError);
    expect(() =>
      route("POST", "/fixtures", {
        requestBody: { mode: "json", onEmptyJsonBody: "coerce" },
      }),
    ).toThrow(InvalidHttpTransportError);
    expect(() => rawBody(null)).toThrow(InvalidHttpTransportError);
    expect(() =>
      rawBody({
        maxBytes: 10,
        contentTypes: ["Application/JSON", "application/json"],
      }),
    ).toThrow(InvalidHttpTransportError);
    expect(() =>
      route("POST", "/fixtures", {
        requestBody: {
          mode: "multipart",
          maxBytes: 10,
          maxFileBytes: 11,
          maxFiles: 1,
          maxFields: 1,
          maxFieldBytes: 1,
        },
      }),
    ).toThrow(InvalidHttpTransportError);
  });

  it("rejects a forged HTTP declaration whose binding and metadata disagree", () => {
    expect(
      isHttpTransport({
        kind: "http",
        binding: "GET /fixtures",
        metadata: {
          method: "POST",
          path: "/fixtures",
          response: "json",
          contentType: "application/json",
          requestBody: { mode: "json" },
        },
      }),
    ).toBe(false);
  });

  it("feeds the application compiler one canonical collision key", () => {
    const first = operation("fixtures.first", http.get("/fixtures/:fixtureId"));
    const second = operation("fixtures.second", http.get("/fixtures/:fixtureId"));
    const module = defineModule({
      id: "fixtures",
      operations: [first, second],
      providers: [],
      imports: [],
      exports: [],
    });

    expect(() => defineApp({ id: "fixture-api", modules: [module] })).toThrow(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: "SHIP_TRANSPORT_BINDING_DUPLICATE",
            path: "transport.binding",
          }),
        ],
      }),
    );
    expect(() => defineApp({ id: "fixture-api", modules: [module] })).toThrow(
      ApplicationCompilationError,
    );
  });
});

function operation(id: `fixtures.${string}`, transport: ReturnType<typeof http.get>) {
  return defineOperation({
    id,
    transport,
    input: {},
    output: { 200: z.object({ ok: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: () => ({ ok: true as const }),
  });
}
