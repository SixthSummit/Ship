import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskStorageAdapter } from "./DiskStorageAdapter.js";

async function streamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("DiskStorageAdapter", () => {
  let rootDir: string;
  let adapter: DiskStorageAdapter;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "ship-disk-storage-"));
    adapter = new DiskStorageAdapter({ rootDir });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("put", () => {
    it("writes a Buffer body and returns the recorded metadata", async () => {
      const meta = await adapter.put("hello.txt", Buffer.from("hello"));
      expect(meta).toMatchObject({ key: "hello.txt", size: 5 });
      expect(meta.lastModified).toBeInstanceOf(Date);
    });

    it("auto-creates intermediate directories", async () => {
      const meta = await adapter.put("nested/deep/file.txt", Buffer.from("x"));
      expect(meta.key).toBe("nested/deep/file.txt");
    });

    it("accepts Uint8Array bodies", async () => {
      const meta = await adapter.put("bin", new Uint8Array([1, 2, 3, 4]));
      expect(meta.size).toBe(4);
    });

    it("accepts Blob / File bodies", async () => {
      const blob = new Blob(["abcde"], { type: "text/plain" });
      const meta = await adapter.put("blob.txt", blob, { contentType: "text/plain" });
      expect(meta.size).toBe(5);
      expect(meta.contentType).toBe("text/plain");
    });

    it("accepts ReadableStream bodies", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("from-stream"));
          controller.close();
        },
      });
      const meta = await adapter.put("streamed.txt", stream);
      expect(meta.size).toBe("from-stream".length);
    });

    it("records the contentType + metadata sidecar when provided", async () => {
      await adapter.put("a.txt", Buffer.from("x"), {
        contentType: "text/plain",
        metadata: { author: "alice" },
      });
      const got = await adapter.get("a.txt");
      expect(got?.meta.contentType).toBe("text/plain");
      expect(got?.meta.metadata).toEqual({ author: "alice" });
    });

    it("does NOT write a sidecar when no extra metadata is supplied", async () => {
      await adapter.put("a.txt", Buffer.from("x"));
      const got = await adapter.get("a.txt");
      // Round-trips with no contentType / metadata
      expect(got?.meta.contentType).toBeUndefined();
      expect(got?.meta.metadata).toBeUndefined();
    });
  });

  describe("get", () => {
    it("returns null for a missing key", async () => {
      expect(await adapter.get("does-not-exist")).toBeNull();
    });

    it("streams the stored content back", async () => {
      await adapter.put("hello.txt", Buffer.from("hello world"));
      const got = await adapter.get("hello.txt");
      expect(got).not.toBeNull();
      const text = await streamToString(got!.stream);
      expect(text).toBe("hello world");
    });

    it("returns the recorded metadata in the meta field", async () => {
      await adapter.put("a.txt", Buffer.from("x"), {
        contentType: "text/plain",
        metadata: { x: "1" },
      });
      const got = await adapter.get("a.txt");
      expect(got?.meta).toMatchObject({
        key: "a.txt",
        size: 1,
        contentType: "text/plain",
        metadata: { x: "1" },
      });
      // Drain the stream so the underlying file handle closes promptly
      await streamToString(got!.stream);
    });
  });

  describe("exists", () => {
    it("returns true for present objects", async () => {
      await adapter.put("k", Buffer.from("v"));
      expect(await adapter.exists("k")).toBe(true);
    });
    it("returns false for absent objects", async () => {
      expect(await adapter.exists("missing")).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes the data and sidecar files", async () => {
      await adapter.put("k", Buffer.from("v"), { contentType: "text/plain" });
      await adapter.delete("k");
      expect(await adapter.exists("k")).toBe(false);
      expect(await adapter.get("k")).toBeNull();
    });

    it("is a no-op for missing keys", async () => {
      await expect(adapter.delete("never-existed")).resolves.toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns all objects under the root, sorted", async () => {
      await adapter.put("a.txt", Buffer.from("1"));
      await adapter.put("b.txt", Buffer.from("22"));
      await adapter.put("nested/c.txt", Buffer.from("333"));

      const result = await adapter.list();
      expect(result.objects.map((o) => o.key)).toEqual(["a.txt", "b.txt", "nested/c.txt"]);
      expect(result.nextContinuationToken).toBeUndefined();
    });

    it("filters by prefix", async () => {
      await adapter.put("alpha", Buffer.from("a"));
      await adapter.put("beta", Buffer.from("b"));
      const result = await adapter.list("al");
      expect(result.objects.map((o) => o.key)).toEqual(["alpha"]);
    });

    it("supports pagination via maxKeys + continuationToken", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.put(`o${i}`, Buffer.from(String(i)));
      }
      const page1 = await adapter.list("", { maxKeys: 2 });
      expect(page1.objects).toHaveLength(2);
      expect(page1.nextContinuationToken).toBeDefined();

      const page2 = await adapter.list("", {
        maxKeys: 2,
        continuationToken: page1.nextContinuationToken,
      });
      expect(page2.objects).toHaveLength(2);

      const page3 = await adapter.list("", {
        maxKeys: 2,
        continuationToken: page2.nextContinuationToken,
      });
      expect(page3.objects).toHaveLength(1);
      expect(page3.nextContinuationToken).toBeUndefined();
    });

    it("ignores .meta.json sidecar files in listings", async () => {
      await adapter.put("a", Buffer.from("v"), { contentType: "text/plain" });
      const result = await adapter.list();
      expect(result.objects.map((o) => o.key)).toEqual(["a"]); // not "a.meta.json"
    });

    it("returns an empty list when the root doesn't exist yet", async () => {
      // Fresh adapter, never wrote anything
      const fresh = new DiskStorageAdapter({ rootDir: path.join(rootDir, "never-created") });
      const result = await fresh.list();
      expect(result.objects).toEqual([]);
    });
  });

  describe("path-traversal guard", () => {
    it("rejects keys starting with /", async () => {
      await expect(adapter.put("/abs", Buffer.from("x"))).rejects.toThrow(/invalid key/);
    });

    it("rejects parent-directory traversal", async () => {
      await expect(adapter.put("../escape", Buffer.from("x"))).rejects.toThrow(/escapes root/);
      await expect(adapter.put("nested/../../escape", Buffer.from("x"))).rejects.toThrow(
        /escapes root/,
      );
    });

    it("rejects empty keys", async () => {
      await expect(adapter.put("", Buffer.from("x"))).rejects.toThrow(/invalid key/);
    });
  });

  describe("signedUrl", () => {
    it("is intentionally not implemented", () => {
      // Type-level: signedUrl is optional on the StorageService interface
      // and DiskStorageAdapter does not implement it. Consumers branch on
      // its presence.
      expect((adapter as unknown as { signedUrl?: unknown }).signedUrl).toBeUndefined();
    });
  });

  describe("symlink defense (F6)", () => {
    let outsideDir: string;
    let outsideFile: string;

    beforeEach(async () => {
      outsideDir = await mkdtemp(path.join(tmpdir(), "ship-disk-outside-"));
      outsideFile = path.join(outsideDir, "secret.txt");
      await writeFile(outsideFile, "external-secret");
    });

    afterEach(async () => {
      await rm(outsideDir, { recursive: true, force: true });
    });

    it("rejects get() on a symlink whose target lives outside rootDir", async () => {
      await symlink(outsideFile, path.join(rootDir, "evil"));
      await expect(adapter.get("evil")).rejects.toThrow(/realpath escapes root/);
    });

    it("rejects exists() on a symlink whose target lives outside rootDir", async () => {
      await symlink(outsideFile, path.join(rootDir, "evil"));
      await expect(adapter.exists("evil")).rejects.toThrow(/realpath escapes root/);
    });

    it("rejects delete() on a symlink pointing outside rootDir (cannot delete external file)", async () => {
      await symlink(outsideFile, path.join(rootDir, "evil"));
      await expect(adapter.delete("evil")).rejects.toThrow(/realpath escapes root/);
    });

    it("rejects put() onto a symlink whose target lives outside rootDir (cannot overwrite external file)", async () => {
      await symlink(outsideFile, path.join(rootDir, "evil"));
      await expect(adapter.put("evil", Buffer.from("hijacked"))).rejects.toThrow(
        /realpath escapes root/,
      );
    });

    it("rejects put() through a symlinked directory pointing outside rootDir", async () => {
      // rootDir/safe -> /tmp/outside/   then put('safe/passwd', ...)
      await symlink(outsideDir, path.join(rootDir, "safe"));
      await expect(adapter.put("safe/passwd", Buffer.from("hijacked"))).rejects.toThrow(
        /realpath escapes root/,
      );
    });

    it("rejects get() through a symlinked directory pointing outside rootDir", async () => {
      await symlink(outsideDir, path.join(rootDir, "leak"));
      // The actual file `outsideDir/secret.txt` is what the symlink reaches.
      await expect(adapter.get("leak/secret.txt")).rejects.toThrow(/realpath escapes root/);
    });

    it("allows symlinks whose target is INSIDE rootDir (legitimate alias)", async () => {
      // rootDir/real.txt — the original. rootDir/alias -> real.txt.
      await adapter.put("real.txt", Buffer.from("payload"));
      await symlink(path.join(rootDir, "real.txt"), path.join(rootDir, "alias"));
      const got = await adapter.get("alias");
      expect(got).not.toBeNull();
    });

    it("regular files still work after the symlink defense is in place", async () => {
      await adapter.put("plain.txt", Buffer.from("ok"));
      const got = await adapter.get("plain.txt");
      expect(got).not.toBeNull();
      expect(await adapter.exists("plain.txt")).toBe(true);
    });

    it("new-key puts inside rootDir (path doesn't yet exist) succeed", async () => {
      const meta = await adapter.put("deep/new/file.txt", Buffer.from("v"));
      expect(meta.key).toBe("deep/new/file.txt");
    });

    it("handles a symlinked rootDir cleanly (canonical-root computed once)", async () => {
      // Create a parallel symlink-rootDir → real rootDir, build a new
      // adapter rooted there; puts/gets work and identify as inside.
      const aliasRoot = path.join(outsideDir, "alias-root");
      await symlink(rootDir, aliasRoot);
      const aliasedAdapter = new DiskStorageAdapter({ rootDir: aliasRoot });
      const meta = await aliasedAdapter.put("hello.txt", Buffer.from("hello"));
      expect(meta.key).toBe("hello.txt");
      const got = await aliasedAdapter.get("hello.txt");
      expect(got).not.toBeNull();
    });

    it("list() does not enumerate symlinked entries pointing outside rootDir", async () => {
      // walkKeys filters by isFile() which is false for symlinks; the
      // defense holds at the list layer too. (Symlinks remain present
      // on disk; they're just hidden from listing.)
      await adapter.put("real.txt", Buffer.from("v"));
      await symlink(outsideFile, path.join(rootDir, "evil"));
      const result = await adapter.list();
      expect(result.objects.map((o) => o.key)).toEqual(["real.txt"]);
    });

    it("a dangling symlink (target deleted) is still detected and rejected", async () => {
      // The symlink resolves outside rootDir, but the target no
      // longer exists. The defense should still refuse the operation.
      await symlink(outsideFile, path.join(rootDir, "evil"));
      await rm(outsideFile, { force: true });
      await expect(adapter.get("evil")).rejects.toThrow(/realpath escapes root/);
    });
  });
});
