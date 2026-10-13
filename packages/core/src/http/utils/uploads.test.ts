import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerErrorHandlers } from "../app/errors.js";
import { ValidationError } from "../errors/ValidationError.js";
import { fileSchema, parseUpload } from "./uploads.js";

function silentLogger() {
  return pino({ level: "silent" }, { write: () => true });
}

function makeFile(name: string, bytes: Uint8Array, type = "application/octet-stream"): File {
  return new File([bytes], name, { type });
}

// PNG magic bytes (IHDR header) — `file-type` recognizes this
const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

const TEXT_BYTES = new TextEncoder().encode("hello world");

function buildAppForUpload<S extends z.ZodType>(schema: S) {
  const app = new Hono();
  registerErrorHandlers(app as unknown as Hono<never>, { logger: silentLogger() });
  app.post("/upload", async (c) => {
    const body = await parseUpload(c, schema);
    // Echo back a coarse summary so tests can check shape
    const summary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v instanceof File) summary[k] = { name: v.name, size: v.size, type: v.type };
      else summary[k] = v;
    }
    return c.json(summary);
  });
  return app;
}

async function multipartRequest(
  app: Hono,
  fields: Record<string, string | File>,
): Promise<Response> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof File) fd.append(k, v);
    else fd.append(k, v);
  }
  return app.request("/upload", { method: "POST", body: fd });
}

describe("parseUpload", () => {
  it("returns the typed body when validation succeeds", async () => {
    const schema = z.object({
      avatar: fileSchema({ maxBytes: 1_000_000 }),
      description: z.string().max(500),
    });
    const app = buildAppForUpload(schema);

    const file = makeFile("hello.txt", TEXT_BYTES, "text/plain");
    const res = await multipartRequest(app, { avatar: file, description: "hi" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      avatar: { size: number; name: string };
      description: string;
    };
    expect(body.avatar.name).toBe("hello.txt");
    expect(body.avatar.size).toBe(TEXT_BYTES.length);
    expect(body.description).toBe("hi");
  });

  it("throws ValidationError when a required field is missing", async () => {
    const schema = z.object({
      avatar: fileSchema(),
      description: z.string(),
    });
    const app = buildAppForUpload(schema);

    const res = await multipartRequest(app, { description: "no file here" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects files exceeding maxBytes", async () => {
    const schema = z.object({
      avatar: fileSchema({ maxBytes: 5 }),
    });
    const app = buildAppForUpload(schema);

    const file = makeFile("big.bin", TEXT_BYTES); // 11 bytes > 5
    const res = await multipartRequest(app, { avatar: file });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/maximum size of 5 bytes/);
  });

  it("rejects files whose magic-byte MIME isn't in the allow-list", async () => {
    const schema = z.object({
      avatar: fileSchema({ mimeTypes: ["image/png"] }),
    });
    const app = buildAppForUpload(schema);

    // text bytes claim Content-Type: image/png but magic bytes say plain
    const spoofed = makeFile("spoof.png", TEXT_BYTES, "image/png");
    const res = await multipartRequest(app, { avatar: spoofed });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // Magic-byte detection couldn't classify TEXT_BYTES as a known type,
    // and allowUndetectedMime defaults to false → "Could not determine".
    expect(body.error.message).toMatch(/file type|not allowed/i);
  });

  it("accepts files whose magic-byte MIME matches", async () => {
    const schema = z.object({
      avatar: fileSchema({ mimeTypes: ["image/png"] }),
    });
    const app = buildAppForUpload(schema);

    const png = makeFile("real.png", PNG_HEADER, "image/png");
    const res = await multipartRequest(app, { avatar: png });
    expect(res.status).toBe(200);
  });

  it("supports allowUndetectedMime: true for plaintext / unknown blobs", async () => {
    const schema = z.object({
      blob: fileSchema({ mimeTypes: ["image/png"], allowUndetectedMime: true }),
    });
    const app = buildAppForUpload(schema);

    const txt = makeFile("data.txt", TEXT_BYTES, "text/plain");
    const res = await multipartRequest(app, { blob: txt });
    // Magic bytes can't classify "hello world" — undetected, allowed
    expect(res.status).toBe(200);
  });

  it("supports a custom detectMime override (test injection)", async () => {
    const detectMime = async () => "image/png";
    const schema = z.object({
      avatar: fileSchema({ mimeTypes: ["image/png"], detectMime }),
    });
    const app = buildAppForUpload(schema);

    const file = makeFile("any.bin", TEXT_BYTES);
    const res = await multipartRequest(app, { avatar: file });
    expect(res.status).toBe(200);
  });

  it("emits a path-prefixed message in the ValidationError", async () => {
    const schema = z.object({
      avatar: fileSchema({ maxBytes: 1 }),
    });
    const app = buildAppForUpload(schema);

    const file = makeFile("x.bin", TEXT_BYTES);
    const res = await multipartRequest(app, { avatar: file });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/^avatar:/);
  });
});

describe("fileSchema — F20 rename + default-deny", () => {
  it("`skipMimeValidationForUndetected: true` accepts undetected files (new explicit name)", async () => {
    const schema = z.object({
      blob: fileSchema({
        mimeTypes: ["image/png"],
        skipMimeValidationForUndetected: true,
      }),
    });
    const app = buildAppForUpload(schema);
    const txt = makeFile("data.txt", TEXT_BYTES, "text/plain");
    const res = await multipartRequest(app, { blob: txt });
    expect(res.status).toBe(200);
  });

  it("`requireDetectableMime: true` rejects files with no detectable magic bytes — even without mimeTypes", async () => {
    const schema = z.object({
      blob: fileSchema({ requireDetectableMime: true }),
    });
    const app = buildAppForUpload(schema);
    const txt = makeFile("data.txt", TEXT_BYTES);
    const res = await multipartRequest(app, { blob: txt });
    expect(res.status).toBe(400);
  });

  it("`requireDetectableMime: true` accepts files with detectable magic bytes (PNG)", async () => {
    const schema = z.object({
      blob: fileSchema({ requireDetectableMime: true }),
    });
    const app = buildAppForUpload(schema);
    const png = makeFile("real.png", PNG_HEADER, "image/png");
    const res = await multipartRequest(app, { blob: png });
    expect(res.status).toBe(200);
  });

  it("legacy `allowUndetectedMime: true` still works (back-compat) but emits a one-time console.warn", async () => {
    // Reset the deprecation tracker so this test sees the warning.
    const { _F20Internals } = await import("./uploads.js");
    _F20Internals.emittedDeprecationWarnings.clear();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      const schema = z.object({
        blob: fileSchema({
          mimeTypes: ["image/png"],
          allowUndetectedMime: true,
        }),
      });
      const app = buildAppForUpload(schema);
      const txt = makeFile("data.txt", TEXT_BYTES, "text/plain");
      const res = await multipartRequest(app, { blob: txt });
      expect(res.status).toBe(200);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/deprecation/);
      expect(warnings[0]).toMatch(/skipMimeValidationForUndetected/);
    } finally {
      console.warn = origWarn;
    }
  });

  it("the deprecation warning only fires once per process", async () => {
    const { _F20Internals } = await import("./uploads.js");
    _F20Internals.emittedDeprecationWarnings.clear();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      // Construct twice.
      fileSchema({ allowUndetectedMime: true });
      fileSchema({ allowUndetectedMime: true });
      fileSchema({ allowUndetectedMime: true });
      expect(warnings.length).toBe(1);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("fileSchema integration with z.safeParseAsync", () => {
  it("can be used standalone (outside parseUpload)", async () => {
    const schema = fileSchema({ maxBytes: 5 });
    const r = await schema.safeParseAsync(makeFile("x.bin", TEXT_BYTES));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/maximum size/);
    }
  });
});

// Sanity: ValidationError is the throw type
describe("parseUpload error contract", () => {
  it("validation failures throw ValidationError (caught by app.onError)", async () => {
    const schema = z.object({ name: z.string() });
    const fakeContext = {
      req: {
        async parseBody() {
          return {};
        },
      },
    } as unknown as Parameters<typeof parseUpload>[0];

    await expect(parseUpload(fakeContext, schema)).rejects.toBeInstanceOf(ValidationError);
  });
});
