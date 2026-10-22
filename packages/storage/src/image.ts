import type { AttachmentVariant } from "@sixthsummit/ship-core";

export interface ImageTransformSource {
  readonly contentType: string;
}

export interface ImageTransformResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Renders one declared variant from the original bytes. The processor is an
 * immediate effect of the `ship-storage.generate-variant` job: it is bound at
 * composition time so the kernel and this package carry no native image
 * dependency.
 */
export interface ImageProcessor {
  readonly kind: "ship.image-processor";
  readonly name: string;
  transform(
    input: Uint8Array,
    variant: AttachmentVariant,
    source: ImageTransformSource,
  ): Promise<ImageTransformResult>;
}

export function isImageProcessor(value: unknown): value is ImageProcessor {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.image-processor" &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "transform") === "function"
  );
}

const FORMAT_CONTENT_TYPES = Object.freeze({
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
  avif: "image/avif",
});

/** The content type a variant renders to: its declared format, else the source type. */
export function variantContentType(variant: AttachmentVariant, source: ImageTransformSource): string {
  return variant.format ? FORMAT_CONTENT_TYPES[variant.format] : source.contentType;
}

/** The file extension a variant key ends with. */
export function variantExtension(contentType: string): string {
  const entry = Object.entries(FORMAT_CONTENT_TYPES).find(([, type]) => type === contentType);
  if (entry) return entry[0] === "jpeg" ? "jpg" : entry[0];
  const subtype = contentType.split("/")[1]?.split(";")[0]?.trim();
  return subtype && /^[a-z0-9+.-]+$/iu.test(subtype) ? subtype.replace("+", "-") : "bin";
}

/**
 * The slice of `sharp` this adapter calls, so the module is injected rather
 * than depended on: `createSharpImageProcessor((await import("sharp")).default)`.
 */
export interface SharpLike {
  (input: Uint8Array): {
    resize(options: {
      readonly width?: number;
      readonly height?: number;
      readonly fit?: "cover" | "contain" | "inside";
      readonly withoutEnlargement?: boolean;
    }): SharpPipelineLike;
  };
}

export interface SharpPipelineLike {
  toFormat(
    format: "webp" | "jpeg" | "png" | "avif",
    options?: { readonly quality?: number },
  ): SharpPipelineLike;
  toBuffer(): Promise<Uint8Array>;
}

export function createSharpImageProcessor(sharp: SharpLike): ImageProcessor {
  if (typeof sharp !== "function") {
    throw new TypeError("createSharpImageProcessor requires the sharp module function");
  }
  const processor: ImageProcessor = {
    kind: "ship.image-processor",
    name: "sharp",
    transform: async (input, variant, source) => {
      let pipeline = sharp(input).resize({
        ...(variant.width !== undefined ? { width: variant.width } : {}),
        ...(variant.height !== undefined ? { height: variant.height } : {}),
        fit: variant.fit ?? "cover",
        withoutEnlargement: true,
      });
      if (variant.format) {
        pipeline = pipeline.toFormat(
          variant.format,
          variant.quality !== undefined ? { quality: variant.quality } : undefined,
        );
      }
      const bytes = await pipeline.toBuffer();
      return Object.freeze({
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        contentType: variantContentType(variant, source),
      });
    },
  };
  return Object.freeze(processor);
}

/**
 * A processor that returns the original bytes relabelled with the variant's
 * content type. It exists for tests and for applications that only need the
 * lifecycle (keys, ledger rows, purge) before a real encoder is wired in.
 */
export function createPassthroughImageProcessor(): ImageProcessor {
  const processor: ImageProcessor = {
    kind: "ship.image-processor",
    name: "passthrough",
    transform: async (input, variant, source) =>
      Object.freeze({ bytes: input, contentType: variantContentType(variant, source) }),
  };
  return Object.freeze(processor);
}
