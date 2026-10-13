import type { Context } from "hono";
import { type ZodType, z } from "zod";
import { ValidationError } from "../errors/ValidationError.js";

/**
 * `parseUpload(c, schema)` — Web-Standards file-upload helper.
 *
 * Replaces v3's Multer integration. Reads `c.req.parseBody({ all: true })`,
 * validates against a Zod schema, returns the typed result. File fields
 * use `fileSchema({ maxBytes, mimeTypes })` (below) which validates size
 * and MIME via *magic bytes* (not the upload's claimed Content-Type — that
 * can be spoofed).
 *
 * **Memory model — be honest**: Hono's `parseBody()` reads the entire
 * multipart body into memory before this function returns, capped by
 * `app.use(bodyLimit({ maxSize: ... }))` if applied (default Hono is
 * effectively unbounded — *always* configure a body limit for upload
 * routes). For true streaming uploads, drop down to
 * `c.req.raw.body` (a `ReadableStream`) and pipe directly to S3/GCS/disk.
 *
 * Usage:
 * ```ts
 * import { z } from "zod";
 * import { parseUpload, fileSchema } from "@sixthsummit/ship-api/http/utils/uploads";
 *
 * const schema = z.object({
 *   avatar: fileSchema({ maxBytes: 5_000_000, mimeTypes: ["image/png", "image/jpeg"] }),
 *   description: z.string().max(500),
 * });
 *
 * app.post("/profile", requireAuth({ provider }), async (c) => {
 *   const body = await parseUpload(c, schema);
 *   await storage.put(`avatars/${user.id}`, body.avatar);
 *   await profileService.update(user.id, { description: body.description });
 *   return c.json({ ok: true });
 * });
 * ```
 *
 * Validation errors throw `ValidationError` (mapped by `registerErrorHandlers`
 * to 400), preserving the AppError taxonomy.
 */

export async function parseUpload<S extends ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  // `parseBody({ all: true })` is required for fields with multiple values
  // (an upload field with multiple files surfaces as `string | File | (string | File)[]`).
  const raw = await c.req.parseBody({ all: true });
  const result = await schema.safeParseAsync(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.length ? first.path.join(".") : "upload";
    throw new ValidationError(`${path}: ${first?.message ?? "Invalid upload"}`);
  }
  return result.data as z.infer<S>;
}

// ─────────────────────────────────────────────────────────────────────────
// fileSchema — Zod schema builder for File fields with size + MIME guards
// ─────────────────────────────────────────────────────────────────────────

export interface FileSchemaOptions {
  /** Maximum file size in bytes. Files larger than this fail validation. */
  maxBytes?: number;
  /**
   * Permitted MIME types validated via magic bytes (NOT the client-supplied
   * Content-Type — that's trivially spoofable). Validation uses the
   * `file-type` package. If omitted, MIME is not checked.
   */
  mimeTypes?: readonly string[];
  /**
   * Optional override for the magic-byte detector. Defaults to
   * `file-type`'s `fileTypeFromBuffer`. Useful for tests or to plug in a
   * stricter / different detector.
   */
  detectMime?: (file: File) => Promise<string | undefined>;
  /**
   * **F20 — explicit replacement for `allowUndetectedMime`.** When the
   * magic-byte detector returns `undefined` (the file's bytes don't
   * match any known type), skip the `mimeTypes` allowlist check and
   * accept the file. Same behavior as the legacy `allowUndetectedMime`
   * but the name spells out the permissive semantics — adopters
   * reading "skip MIME validation for undetected files" can't
   * mistake it for "validate everything defensively."
   *
   * Default `false` (fail closed). Set `true` when accepting CSV /
   * JSON / generic binary blobs that lack distinctive magic bytes.
   */
  skipMimeValidationForUndetected?: boolean;
  /**
   * **F20 — default-deny escalation.** When `true`, reject any file
   * whose magic bytes can't be classified, *regardless of whether
   * `mimeTypes` is set*. Without this, a `parseUpload` call with no
   * `mimeTypes` allowlist accepts everything — including files with
   * no detectable signature that an attacker could pass off as
   * legitimate text-but-aren't payloads (SVG-XSS staging, etc.).
   * Default `false` for backwards compatibility.
   */
  requireDetectableMime?: boolean;
  /**
   * @deprecated since v4.0.0-alpha.4 (F20). Renamed to
   * `skipMimeValidationForUndetected` for explicit semantics. Setting
   * this still works for one minor cycle but emits a one-time
   * `console.warn`. Will be removed in v4.1.0.
   */
  allowUndetectedMime?: boolean;
}

async function defaultDetectMime(file: File): Promise<string | undefined> {
  // file-type's recommended buffer size is 4100 bytes; the package only
  // looks at the leading bytes for its signatures. Slicing avoids reading
  // the whole file when only the head matters.
  const head = await file.slice(0, 4100).arrayBuffer();
  const { fileTypeFromBuffer } = await import("file-type");
  const result = await fileTypeFromBuffer(new Uint8Array(head));
  return result?.mime;
}

/**
 * Tracks deprecation warnings emitted in the current process so the
 * one-time `console.warn` (F20) doesn't spam logs on a hot upload
 * path. Module-level set — wide enough scope to survive multiple
 * `fileSchema` constructions, narrow enough to reset per process.
 */
const emittedDeprecationWarnings = new Set<string>();

function warnDeprecatedOnce(key: string, message: string): void {
  if (emittedDeprecationWarnings.has(key)) return;
  emittedDeprecationWarnings.add(key);
  console.warn(`[ship-api/uploads] deprecation: ${message}`);
}

export function fileSchema(opts: FileSchemaOptions = {}): ZodType<File> {
  // F20: resolve the rename + deprecation. Either explicit option wins;
  // the legacy `allowUndetectedMime` still works for one minor cycle.
  const skipForUndetected =
    opts.skipMimeValidationForUndetected ?? opts.allowUndetectedMime ?? false;
  if (opts.allowUndetectedMime !== undefined) {
    warnDeprecatedOnce(
      "allowUndetectedMime",
      "`allowUndetectedMime` is deprecated — rename to " +
        "`skipMimeValidationForUndetected` (same semantics, clearer name). " +
        "The old name will be removed in v4.1.0.",
    );
  }
  const requireDetectable = opts.requireDetectableMime ?? false;

  return z
    .instanceof(File, { message: "Expected an uploaded file" })
    .superRefine(async (file, ctx) => {
      if (opts.maxBytes !== undefined && file.size > opts.maxBytes) {
        ctx.addIssue({
          code: "custom",
          message: `File exceeds maximum size of ${opts.maxBytes} bytes (got ${file.size})`,
        });
        return;
      }

      const detected = await (opts.detectMime ?? defaultDetectMime)(file);

      // F20: explicit default-deny escalation. Fires regardless of
      // whether `mimeTypes` is set, so a no-allowlist `parseUpload`
      // can still reject magic-byte-undetectable files.
      if (requireDetectable && !detected) {
        ctx.addIssue({
          code: "custom",
          message: "File magic bytes could not be classified (requireDetectableMime: true)",
        });
        return;
      }

      if (opts.mimeTypes && opts.mimeTypes.length > 0) {
        if (!detected) {
          if (!skipForUndetected) {
            ctx.addIssue({
              code: "custom",
              message: "Could not determine file type from contents",
            });
          }
          return;
        }
        if (!opts.mimeTypes.includes(detected)) {
          ctx.addIssue({
            code: "custom",
            message: `MIME type "${detected}" not allowed (permitted: ${opts.mimeTypes.join(", ")})`,
          });
        }
      }
    });
}

/** Exposed for tests; do not depend on this outside the framework. */
export const _F20Internals = { emittedDeprecationWarnings };
