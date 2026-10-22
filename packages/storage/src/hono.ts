import { http } from "@sixthsummit/ship-hono";
import type { StorageModuleTransports } from "./module.js";

export interface StorageHttpTransportOptions<TBasePath extends string = "/storage"> {
  /** Defaults to `/storage`. */
  readonly basePath?: TBasePath;
  /** Maximum intent body size; defaults to 4 KiB. */
  readonly maxBodyBytes?: number;
}

/**
 * HTTP transports for the storage module: `POST <base>/intents` creates a
 * signed upload intent and `POST <base>/intents/:intentId/complete` settles
 * it. Pass the result as `transports` to `defineStorageModule`.
 */
export function storageHttpTransports<const TBasePath extends string = "/storage">(
  options: StorageHttpTransportOptions<TBasePath> = {},
) {
  const basePath = normalizeBasePath(options.basePath ?? "/storage") as TBasePath;
  const requestBody = http.body.json({ maxBytes: options.maxBodyBytes ?? 4_096 });
  return Object.freeze({
    createIntent: http.post(`${basePath}/intents`, { requestBody }),
    complete: http.post(`${basePath}/intents/:intentId/complete`, { requestBody }),
  }) satisfies Required<StorageModuleTransports>;
}

function normalizeBasePath(path: string): string {
  if (typeof path !== "string" || !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u.test(path)) {
    throw new TypeError(
      `storage basePath must be an absolute path of plain segments; received ${JSON.stringify(path)}`,
    );
  }
  return path;
}
