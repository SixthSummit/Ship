# File uploads

> **Compatibility and migration guide:** `parseUpload` remains supported. New
> HTTP operations declare bounded multipart policy in `http.body.multipart()`;

`parseUpload` and `fileSchema` — Zod-validated multipart form parsing with magic-byte MIME detection. Plus the streaming alternative for large uploads.

## The standard pattern

```ts
import { parseUpload, fileSchema } from "@sixthsummit/ship-api";
import { z } from "zod";

const avatarSchema = z.object({
  avatar: fileSchema({
    maxBytes: 5_000_000,                     // 5 MB
    mimeTypes: ["image/png", "image/jpeg", "image/webp"],
  }),
  description: z.string().max(500).optional(),
});

app.post(
  "/profile/avatar",
  requireAuth({ provider }),
  async (c) => {
    const body = await parseUpload(c, avatarSchema);
    // body.avatar is a File; body.description is string | undefined

    const buffer = Buffer.from(await body.avatar.arrayBuffer());
    await storage.put(`avatars/${c.var.user.id}`, buffer, { contentType: body.avatar.type });

    return c.json({ ok: true });
  },
);
```

Three things are happening:

1. `parseUpload(c, schema)` reads the multipart body via Hono's `parseBody({ all: true })`, which returns a `Record<string, string | File | (string | File)[]>`.
2. The result is validated against the Zod schema. `fileSchema` is a custom Zod helper that runs file-specific validation (size, MIME).
3. The handler gets a typed object — `body.avatar` is a `File`, `body.description` is `string | undefined`.

## `fileSchema` options

```ts
interface FileSchemaOptions {
  maxBytes?: number;                                          // file size limit
  mimeTypes?: readonly string[];                              // allowed MIME types
  detectMime?: (file: File) => Promise<string | undefined>;   // custom detector
  allowUndetectedMime?: boolean;                              // permit files where detection failed
}
```

Default behavior:

- **Magic-byte detection.** Uses [`file-type`](https://www.npmjs.com/package/file-type) to identify MIME from the first 4100 bytes of the file. **Does not trust the client-supplied `Content-Type`** — that header can lie. The detected type is what's checked against `mimeTypes`.
- **`allowUndetectedMime: false`.** If the file-type library can't identify the file (e.g., novel formats, plain text), the validation fails. Set to `true` if you accept files that file-type doesn't recognize.

For custom detection (e.g., a domain-specific format file-type doesn't know):

```ts
fileSchema({
  maxBytes: 50_000_000,
  mimeTypes: ["application/x-my-format"],
  detectMime: async (file) => {
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (matches(bytes, MY_MAGIC_BYTES)) return "application/x-my-format";
    return undefined;
  },
});
```

## Why magic bytes, not headers

A client can send `Content-Type: image/png` while the body is actually a PHP shell. Browsers (and intermediaries like CDNs) sometimes auto-detect content type from the actual bytes, but trusting the client's header would let an attacker upload anything. Magic-byte detection reads the actual bytes — `89 50 4E 47` for PNG, `FF D8 FF` for JPEG, `52 49 46 46` for RIFF/WebP — and validates against those.

This shifts the work to upload time (read first 4100 bytes, look up signature) but eliminates a class of upload-as-RCE bugs. The performance cost is small enough that it's the framework's default.

## Memory model and request size limits

Hono's `parseBody({ all: true })` reads the entire multipart request into memory before returning. For a 5 MB avatar that's fine; for a 1 GB upload it's catastrophic. **Always bound the total request size**:

```ts
import { bodyLimit } from "hono/body-limit";

app.use(
  "/uploads/*",
  bodyLimit({
    maxSize: 50 * 1024 * 1024,     // 50 MB total request
    onError: () => { throw new BadRequestError("Upload too large"); },
  }),
);
```

`bodyLimit` runs before `parseUpload`, so files exceeding the cap never reach the parser. Inside the parser, `fileSchema`'s `maxBytes` enforces a per-file cap on what was already read into memory.

The defaults to start with:

- `bodyLimit({ maxSize })` — set to your largest expected request payload (sum of all files + form fields, plus a margin).
- `fileSchema({ maxBytes })` — set per-file based on what makes sense. Avatars: a few MB. Documents: tens of MB. Video: don't use `parseUpload`, see "Streaming uploads" below.

## Streaming uploads — for large files

For uploads that don't fit comfortably in memory, drop down to the raw request stream:

```ts
import { Readable } from "node:stream";

app.post(
  "/uploads/large",
  requireAuth({ provider }),
  async (c) => {
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new BadRequestError("Missing body");

    // Pipe directly to S3 / GCS / disk — no memory buffer
    await s3.upload({
      Bucket: env.S3_BUCKET,
      Key: `uploads/${c.var.user.id}/${randomUUID()}`,
      Body: Readable.from(streamFromReader(reader)),
      ContentType: c.req.header("content-type") ?? "application/octet-stream",
    }).promise();

    return c.json({ ok: true });
  },
);
```

Streaming bypasses Hono's `parseBody`, which means:

- You lose `parseUpload`'s automatic Zod validation. Validate any form fields out-of-band (e.g., as query params or headers).
- You lose magic-byte MIME detection. If you need it, read the first 4100 bytes, check, then continue streaming.
- The browser-side multipart format isn't necessarily what the cloud provider expects. For S3/GCS direct uploads, prefer **PUT signed URLs** (see [storage](storage.md)) — the browser uploads directly to the cloud, your server never sees the bytes.

For most apps the right answer is "use PUT signed URLs for large uploads." The streaming-through-the-server pattern is for cases where you genuinely need to inspect bytes before they hit storage (virus scanning, format conversion).

## Multiple files in one upload

`fileSchema` validates a single file. For arrays, use Zod's `.array()`:

```ts
const galleryUpload = z.object({
  images: z.array(
    fileSchema({ maxBytes: 5_000_000, mimeTypes: ["image/png", "image/jpeg"] }),
  ).min(1).max(10),
  caption: z.string().max(500).optional(),
});

app.post("/gallery", async (c) => {
  const body = await parseUpload(c, galleryUpload);
  // body.images is File[]
  for (const file of body.images) {
    await storage.put(`gallery/${randomUUID()}`, file, { contentType: file.type });
  }
  return c.json({ ok: true });
});
```

The client posts multiple parts under the same field name (`images`); Hono's `parseBody({ all: true })` collects them into an array. The Zod schema validates each one.

## React Native compatibility

RN's FormData is Web Standards–compatible since RN 0.72. The pattern:

```ts
// React Native client
const fd = new FormData();
fd.append("avatar", {
  uri: localFileUri,
  name: "photo.jpg",
  type: "image/jpeg",
} as any);
fd.append("description", "My new avatar");

await fetch(`${BASE_URL}/profile/avatar`, {
  method: "POST",
  body: fd,
  headers: { Authorization: `Bearer ${token}` },
});
```

Server-side, `parseUpload` doesn't care about the client — it sees a multipart request and parses it. The only RN-specific piece is the `{ uri, name, type }` object the RN FormData accepts as a file value.

## Errors

`parseUpload` throws `ValidationError` on schema mismatches — which `registerErrorHandlers` turns into 400 with the standard error envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      { "path": ["avatar"], "message": "File exceeds 5000000 bytes" },
      { "path": ["avatar"], "message": "MIME type 'application/pdf' not allowed" }
    ]
  }
}
```

The Zod issues carry through to the client unchanged — same shape as any other `validate()` failure. See [errors](../concepts/errors.md).

## Operational concerns

**Disk space, not just memory.** If you're storing files on `DiskStorageAdapter`, monitor disk usage. Uploads accumulate; cleanup of old/orphaned files is your responsibility.

**Virus scanning.** The framework doesn't ship antivirus integration. For workloads where users upload files other users will download (file sharing, document collaboration), scan uploads via ClamAV or a managed service before serving them.

**Image processing.** Resize / re-encode / strip EXIF metadata is application-level work. Sharp is the standard Node library; do this in a job (see [jobs](jobs.md)) so the upload response returns fast and processing happens asynchronously.

**Don't echo file names.** A file named `<script>alert(1)</script>.png` can XSS your UI if you render it raw. Validate / sanitize on display, or store under a generated UUID and remember the original name in metadata.

## Source

- [`packages/core/src/http/utils/uploads.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/utils/uploads.ts) — `parseUpload`, `fileSchema`
- [`file-type`](https://www.npmjs.com/package/file-type) — magic-byte detection library
- [Hono body-limit middleware docs](https://hono.dev/docs/middleware/builtin/body-limit) — `bodyLimit` for total-request-size caps
