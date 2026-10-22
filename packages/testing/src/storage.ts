import type {
  AttachmentAttachInput,
  AttachmentCompletionInput,
  AttachmentDetachInput,
  AttachmentIntent,
  AttachmentIntentInput,
  AttachmentLedger,
  AttachmentObject,
  AttachmentPurge,
  AttachmentVariantObject,
  StorageAdapter,
  StorageObjectMeta,
  StorageSignedUpload,
  StorageSignUploadRequest,
} from "@sixthsummit/ship-core";

/**
 * In-process object store for unit tests. Signed URLs are `memory://` tokens
 * the adapter itself redeems through `upload()`, which plays the browser's
 * PUT: it enforces the content type and the declared size the signature was
 * issued for, exactly as a provider rejects a mismatched signed upload.
 */
export interface InMemoryStorageAdapter extends StorageAdapter {
  readonly adapter: "memory";
  /** Redeems a signed upload URL as the client would with a PUT; returns the provider status. */
  upload(
    url: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>,
    now?: Date,
  ): Promise<number>;
  keys(): readonly string[];
  clear(): void;
}

export interface InMemoryStorageAdapterOptions {
  /** Base for public and download URLs. Defaults to `https://storage.example.test`. */
  readonly baseUrl?: string;
  readonly now?: () => Date;
}

interface StoredObject {
  readonly body: Uint8Array;
  readonly meta: StorageObjectMeta;
}

interface SignedUploadGrant {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly expiresAt: Date;
}

export function createInMemoryStorageAdapter(
  options: InMemoryStorageAdapterOptions = {},
): InMemoryStorageAdapter {
  const baseUrl = (options.baseUrl ?? "https://storage.example.test").replace(/\/+$/u, "");
  const now = options.now ?? (() => new Date());
  const objects = new Map<string, StoredObject>();
  const grants = new Map<string, SignedUploadGrant>();
  let sequence = 0;

  const meta = (key: string, body: Uint8Array, contentType: string): StorageObjectMeta =>
    Object.freeze({
      key,
      size: body.byteLength,
      contentType,
      etag: `"${body.byteLength}-${sequence}"`,
      lastModified: now(),
    });

  return {
    kind: "ship.storage-adapter",
    provider: "memory",
    adapter: "memory",
    signUpload: async (request: StorageSignUploadRequest): Promise<StorageSignedUpload> => {
      sequence += 1;
      const token = `grant-${sequence}`;
      grants.set(token, {
        key: request.key,
        contentType: request.contentType,
        size: request.size,
        expiresAt: request.expiresAt,
      });
      return Object.freeze({
        url: `memory://upload/${token}`,
        method: "PUT" as const,
        headers: Object.freeze({ "content-type": request.contentType }),
        expiresAt: request.expiresAt,
      });
    },
    upload: async (url, body, headers, at = now()) => {
      const token = url.replace(/^memory:\/\/upload\//u, "");
      const grant = grants.get(token);
      if (!grant) return 403;
      if (grant.expiresAt.getTime() <= at.getTime()) return 403;
      const contentType = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === "content-type",
      )?.[1];
      if (contentType !== grant.contentType) return 403;
      if (body.byteLength !== grant.size) return 400;
      sequence += 1;
      objects.set(grant.key, { body, meta: meta(grant.key, body, grant.contentType) });
      grants.delete(token);
      return 200;
    },
    head: async (key) => objects.get(key)?.meta,
    get: async (key) => {
      const stored = objects.get(key);
      return stored ? { body: stored.body, meta: stored.meta } : undefined;
    },
    put: async (key, body, putOptions) => {
      sequence += 1;
      const stored = { body, meta: meta(key, body, putOptions.contentType) };
      objects.set(key, stored);
      return stored.meta;
    },
    delete: async (key) => {
      objects.delete(key);
    },
    signDownload: async (key, signOptions) =>
      `${baseUrl}/${key}?expires=${signOptions.expiresAt.getTime()}&signature=memory`,
    publicUrl: (key) => `${baseUrl}/${key}`,
    health: async () => ({ available: true, detail: `${objects.size} objects` }),
    keys: () => Object.freeze([...objects.keys()].sort()),
    clear: () => {
      objects.clear();
      grants.clear();
    },
  };
}

/**
 * In-process attachment ledger for unit tests. It ignores the unit-of-work
 * scope, so an attach or detach is visible as soon as the call resolves even
 * if the surrounding fake transaction later fails; use the Drizzle ledger
 * with a real database to prove rollback semantics.
 */
export interface InMemoryAttachmentLedger extends AttachmentLedger {
  readonly adapter: "memory";
  intents(): readonly AttachmentIntent[];
  objects(): readonly AttachmentObject[];
  purges(): readonly AttachmentPurge[];
  clear(): void;
}

export function createInMemoryAttachmentLedger(): InMemoryAttachmentLedger {
  const intents = new Map<string, AttachmentIntent>();
  const objects = new Map<string, AttachmentObject>();
  const purges = new Map<string, AttachmentPurge>();

  const requestPurge = (object: AttachmentObject, requestedAt: Date): AttachmentObject => {
    const purging = Object.freeze({ ...object, status: "purging" as const });
    objects.set(object.id, purging);
    if (!purges.has(object.id)) {
      purges.set(
        object.id,
        Object.freeze({
          objectId: object.id,
          keys: Object.freeze([
            object.key,
            ...Object.values(object.variants).map((variant) => variant.key),
          ]),
          requestedAt,
          attempts: 0,
        }),
      );
    }
    return purging;
  };

  return {
    kind: "ship.attachment-ledger",
    adapter: "memory",
    createIntent: async (input: AttachmentIntentInput) => {
      const intent = Object.freeze({
        id: input.id,
        attachmentId: input.attachmentId,
        key: input.key,
        contentType: input.contentType,
        size: input.size,
        actorId: input.actorId,
        status: "pending" as const,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      });
      intents.set(intent.id, intent);
      return intent;
    },
    readIntent: async (intentId) => intents.get(intentId),
    completeIntent: async (input: AttachmentCompletionInput) => {
      const pending = intents.get(input.intentId);
      if (!pending || pending.status !== "pending") return undefined;
      const intent = Object.freeze({
        ...pending,
        status: "completed" as const,
        completedAt: input.completedAt,
        objectId: input.objectId,
      });
      intents.set(intent.id, intent);
      const object = Object.freeze({
        id: input.objectId,
        attachmentId: pending.attachmentId,
        key: pending.key,
        contentType: input.contentType,
        size: input.size,
        status: "uploaded" as const,
        uploadedBy: pending.actorId,
        createdAt: input.completedAt,
        variants: Object.freeze({}),
      });
      objects.set(object.id, object);
      return Object.freeze({ intent, object });
    },
    claimExpiredIntents: async (now, limit) => {
      const claimed: AttachmentIntent[] = [];
      for (const intent of [...intents.values()].sort(
        (left, right) => left.expiresAt.getTime() - right.expiresAt.getTime(),
      )) {
        if (claimed.length >= limit) break;
        if (intent.status !== "pending" || intent.expiresAt.getTime() > now.getTime()) continue;
        const abandoned = Object.freeze({
          ...intent,
          status: "abandoned" as const,
          abandonedAt: now,
        });
        intents.set(intent.id, abandoned);
        claimed.push(abandoned);
      }
      return Object.freeze(claimed);
    },
    readObject: async (objectId) => objects.get(objectId),
    listObjects: async (attachmentId, ownerId) =>
      Object.freeze(
        [...objects.values()]
          .filter(
            (object) =>
              object.attachmentId === attachmentId &&
              object.ownerId === ownerId &&
              object.status === "attached",
          )
          .sort(
            (left, right) =>
              (left.attachedAt?.getTime() ?? 0) - (right.attachedAt?.getTime() ?? 0) ||
              left.id.localeCompare(right.id),
          ),
      ),
    attach: async (_scope, input: AttachmentAttachInput) => {
      const object = objects.get(input.objectId);
      if (
        !object ||
        object.attachmentId !== input.attachmentId ||
        object.status !== "uploaded"
      ) {
        return undefined;
      }
      const attached = Object.freeze({
        ...object,
        status: "attached" as const,
        ownerId: input.ownerId,
        attachedAt: input.attachedAt,
      });
      objects.set(object.id, attached);
      return attached;
    },
    detach: async (_scope, input: AttachmentDetachInput) =>
      Object.freeze(
        [...objects.values()]
          .filter(
            (object) =>
              object.attachmentId === input.attachmentId &&
              object.ownerId === input.ownerId &&
              object.status === "attached" &&
              (input.objectId === undefined || object.id === input.objectId),
          )
          .map((object) => requestPurge(object, input.requestedAt)),
      ),
    claimStaleObjects: async (cutoff, limit) =>
      Object.freeze(
        [...objects.values()]
          .filter(
            (object) =>
              object.status === "uploaded" && object.createdAt.getTime() <= cutoff.getTime(),
          )
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .slice(0, limit)
          .map((object) => requestPurge(object, new Date())),
      ),
    recordVariant: async (objectId, name, variant: AttachmentVariantObject) => {
      const object = objects.get(objectId);
      if (!object) return;
      objects.set(
        objectId,
        Object.freeze({
          ...object,
          variants: Object.freeze({ ...object.variants, [name]: Object.freeze({ ...variant }) }),
        }),
      );
    },
    readPurge: async (objectId) => purges.get(objectId),
    markPurged: async (objectId, purgedAt) => {
      const purge = purges.get(objectId);
      if (!purge || purge.purgedAt) return false;
      purges.set(objectId, Object.freeze({ ...purge, purgedAt, attempts: purge.attempts + 1 }));
      const object = objects.get(objectId);
      if (object) objects.set(objectId, Object.freeze({ ...object, status: "purged" as const }));
      return true;
    },
    health: async () => ({
      available: true,
      detail: `${[...purges.values()].filter((purge) => !purge.purgedAt).length} purges owed`,
    }),
    intents: () => Object.freeze([...intents.values()]),
    objects: () => Object.freeze([...objects.values()]),
    purges: () => Object.freeze([...purges.values()]),
    clear: () => {
      intents.clear();
      objects.clear();
      purges.clear();
    },
  };
}

export interface StorageConformanceCheck {
  readonly name: string;
  run(): Promise<void>;
}

export class StorageConformanceError extends Error {
  readonly check: string;

  constructor(check: string, message: string) {
    super(`${check}: ${message}`);
    this.name = "StorageConformanceError";
    this.check = check;
  }
}

export interface StorageAdapterConformanceOptions {
  /**
   * Plays the client's PUT against a signed upload. Adapters that cannot be
   * driven in-process (a real bucket) omit it and the signed-upload checks
   * only assert the grant's shape.
   */
  readonly performUpload?: (
    adapter: StorageAdapter,
    signed: StorageSignedUpload,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ) => Promise<number>;
}

/**
 * The behavioral contract every StorageAdapter must satisfy, expressed as
 * runner-agnostic checks so the same suite runs against the in-memory
 * adapter, the local-disk adapter and a real bucket. `createAdapter` must
 * return an empty store on every call.
 */
export function storageAdapterConformance(
  createAdapter: () => StorageAdapter | Promise<StorageAdapter>,
  options: StorageAdapterConformanceOptions = {},
): readonly StorageConformanceCheck[] {
  const check = (
    name: string,
    run: (adapter: StorageAdapter) => Promise<void>,
  ): StorageConformanceCheck => ({
    name,
    run: async () => {
      await run(await createAdapter());
    },
  });
  const expect = (name: string, condition: unknown, message: string): void => {
    if (!condition) throw new StorageConformanceError(name, message);
  };
  const bytes = (text: string) => new TextEncoder().encode(text);
  const future = () => new Date(Date.now() + 60_000);

  return Object.freeze([
    check("declares the adapter contract", async (adapter) => {
      expect(
        "declares the adapter contract",
        adapter.kind === "ship.storage-adapter" && adapter.provider.length > 0,
        "expected kind ship.storage-adapter and a provider name",
      );
    }),
    check("head and get miss for an unknown key", async (adapter) => {
      expect(
        "head and get miss for an unknown key",
        (await adapter.head("absent")) === undefined && (await adapter.get("absent")) === undefined,
        "expected undefined for an unknown key",
      );
    }),
    check("round-trips an object with its content type", async (adapter) => {
      const body = bytes("hello");
      const written = await adapter.put("a/b.txt", body, { contentType: "text/plain" });
      const head = await adapter.head("a/b.txt");
      const read = await adapter.get("a/b.txt");
      expect(
        "round-trips an object with its content type",
        written.key === "a/b.txt" &&
          written.size === 5 &&
          head?.size === 5 &&
          head.contentType === "text/plain" &&
          read !== undefined &&
          new TextDecoder().decode(read.body) === "hello",
        "expected the stored bytes and metadata back",
      );
    }),
    check("overwrites an existing key", async (adapter) => {
      await adapter.put("k", bytes("one"), { contentType: "text/plain" });
      await adapter.put("k", bytes("three"), { contentType: "text/plain" });
      const read = await adapter.get("k");
      expect(
        "overwrites an existing key",
        read !== undefined && new TextDecoder().decode(read.body) === "three",
        "expected the newer bytes",
      );
    }),
    check("deletes idempotently", async (adapter) => {
      await adapter.put("gone", bytes("x"), { contentType: "text/plain" });
      await adapter.delete("gone");
      await adapter.delete("gone");
      await adapter.delete("never-existed");
      expect(
        "deletes idempotently",
        (await adapter.head("gone")) === undefined,
        "expected the key to be gone",
      );
    }),
    check("signs an upload grant bound to the request", async (adapter) => {
      const expiresAt = future();
      const signed = await adapter.signUpload({
        key: "uploads/1",
        contentType: "image/png",
        size: 4,
        expiresAt,
      });
      expect(
        "signs an upload grant bound to the request",
        signed.method === "PUT" &&
          typeof signed.url === "string" &&
          signed.url.length > 0 &&
          signed.expiresAt.getTime() === expiresAt.getTime() &&
          Object.entries(signed.headers).some(
            ([name, value]) => name.toLowerCase() === "content-type" && value === "image/png",
          ),
        "expected a PUT grant carrying the content type and expiry",
      );
      if (!options.performUpload) return;
      const status = await options.performUpload(adapter, signed, bytes("abcd"), signed.headers);
      const head = await adapter.head("uploads/1");
      expect(
        "signs an upload grant bound to the request",
        status >= 200 && status < 300 && head?.size === 4 && head.contentType === "image/png",
        `expected the signed PUT to store the object, status ${status}`,
      );
    }),
    check("rejects a signed upload with another content type", async (adapter) => {
      if (!options.performUpload) return;
      const signed = await adapter.signUpload({
        key: "uploads/2",
        contentType: "image/png",
        size: 4,
        expiresAt: future(),
      });
      const status = await options.performUpload(adapter, signed, bytes("abcd"), {
        "content-type": "text/plain",
      });
      expect(
        "rejects a signed upload with another content type",
        status >= 400 && (await adapter.head("uploads/2")) === undefined,
        `expected the provider to refuse the mismatched upload, status ${status}`,
      );
    }),
    check("rejects an expired signed upload", async (adapter) => {
      if (!options.performUpload) return;
      const signed = await adapter.signUpload({
        key: "uploads/3",
        contentType: "image/png",
        size: 4,
        expiresAt: new Date(Date.now() - 1_000),
      });
      const status = await options.performUpload(adapter, signed, bytes("abcd"), signed.headers);
      expect(
        "rejects an expired signed upload",
        status >= 400 && (await adapter.head("uploads/3")) === undefined,
        `expected the provider to refuse the expired upload, status ${status}`,
      );
    }),
    check("signs download urls and exposes stable public urls", async (adapter) => {
      await adapter.put("public/x.png", bytes("png"), { contentType: "image/png" });
      const first = await adapter.signDownload("public/x.png", { expiresAt: future() });
      const second = await adapter.signDownload("public/x.png", {
        expiresAt: new Date(Date.now() + 120_000),
      });
      expect(
        "signs download urls and exposes stable public urls",
        first.length > 0 &&
          first !== second &&
          adapter.publicUrl("public/x.png") === adapter.publicUrl("public/x.png") &&
          adapter.publicUrl("public/x.png").includes("public/x.png"),
        "expected distinct signed urls and a stable public url",
      );
    }),
    check("reports health", async (adapter) => {
      const health = await adapter.health();
      expect("reports health", health.available === true, "expected an available adapter");
    }),
  ]);
}

/** Runs every conformance check and returns the failures, if any. */
export async function runStorageAdapterConformance(
  createAdapter: () => StorageAdapter | Promise<StorageAdapter>,
  options: StorageAdapterConformanceOptions = {},
): Promise<readonly { readonly name: string; readonly error?: Error }[]> {
  const results: { name: string; error?: Error }[] = [];
  for (const check of storageAdapterConformance(createAdapter, options)) {
    try {
      await check.run();
      results.push({ name: check.name });
    } catch (error) {
      results.push({ name: check.name, error: error as Error });
    }
  }
  return Object.freeze(results);
}
