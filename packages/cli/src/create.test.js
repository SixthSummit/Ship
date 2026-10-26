import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationProject, loadScaffoldReleaseManifest, ScaffoldError } from "./create.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const templateDirectory = resolve(sourceDirectory, "../templates/operation");
const releaseManifest = {
  schemaVersion: 1,
  packageManager: "pnpm@10.34.5",
  packages: {
    "@sixthsummit/ship-contract": "0.1.0-alpha.4",
    "@sixthsummit/ship-core": "0.1.0-alpha.3",
    "@sixthsummit/ship-hono": "0.2.0-alpha.1",
  },
  dependencies: {
    "@hono/node-server": "^1.19.14",
    hono: "^4.13.13",
    zod: "^4.3.6",
  },
  devDependencies: {
    "@biomejs/biome": "2.3.11",
    "@sixthsummit/ship-cli": "0.2.0-alpha.1",
    "@types/node": "^24.1.0",
    "@vitest/coverage-v8": "^4.1.8",
    tsx: "^4.20.3",
    typescript: "^5.9.2",
    vitest: "^4.1.8",
  },
};

describe("operation-native scaffold", () => {
  let temporaryDirectory;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "ship-cli-create-test-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it("renders an exact, tested application contract without installing", async () => {
    const install = vi.fn();
    const result = await createOperationProject({
      projectName: "billing-api",
      cwd: temporaryDirectory,
      skipInstall: true,
      templateDirectory,
      releaseManifest,
      install,
    });

    expect(result).toEqual({
      packageName: "billing-api",
      targetDirectory: resolve(temporaryDirectory, "billing-api"),
      installed: false,
    });
    expect(install).not.toHaveBeenCalled();
    const manifest = JSON.parse(
      await readFile(resolve(temporaryDirectory, "billing-api/package.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      name: "billing-api",
      packageManager: "pnpm@10.34.5",
      dependencies: { ...releaseManifest.packages, hono: "^4.13.13" },
      devDependencies: { "@sixthsummit/ship-cli": "0.2.0-alpha.1" },
    });
    for (const [name, version] of Object.entries(releaseManifest.packages)) {
      expect(manifest.dependencies[name], `${name} must be pinned exactly`).toBe(version);
      expect(version).not.toMatch(/^[\^~]/u);
    }
    expect(
      await readFile(
        resolve(temporaryDirectory, "billing-api/src/modules/system/health.operation.ts"),
        "utf8",
      ),
    ).toContain('service: z.literal("billing-api")');
    expect(
      await readFile(resolve(temporaryDirectory, "billing-api/.gitmessage"), "utf8"),
    ).toContain("<type>[optional scope]");
    await expect(
      readFile(resolve(temporaryDirectory, "billing-api/package.template.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs an injected installer after rendering", async () => {
    const install = vi.fn();

    const result = await createOperationProject({
      projectName: "installed-api",
      cwd: temporaryDirectory,
      templateDirectory,
      releaseManifest,
      install,
    });

    expect(result.installed).toBe(true);
    expect(install).toHaveBeenCalledWith(resolve(temporaryDirectory, "installed-api"));
  });

  it("runs pnpm when no installer override is supplied", async () => {
    const spawn = vi.fn(() => ({ status: 0 }));

    await createOperationProject({
      projectName: "default-install-api",
      cwd: temporaryDirectory,
      templateDirectory,
      releaseManifest,
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      "pnpm",
      ["install"],
      expect.objectContaining({ cwd: resolve(temporaryDirectory, "default-install-api") }),
    );
  });

  it.each([
    [{ status: 7 }, "pnpm install exited with 7"],
    [{ status: null }, "pnpm install exited with no status"],
    [{ status: null, error: new Error("pnpm missing") }, "pnpm missing"],
  ])("rolls back a failed pnpm install %#", async (spawnResult, message) => {
    await expect(
      createOperationProject({
        projectName: "install-failure-api",
        cwd: temporaryDirectory,
        templateDirectory,
        releaseManifest,
        spawn: () => spawnResult,
      }),
    ).rejects.toThrow(message);
    await expect(
      readFile(resolve(temporaryDirectory, "install-failure-api/package.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only its newly-created target when generation fails", async () => {
    const target = resolve(temporaryDirectory, "failed-api");

    await expect(
      createOperationProject({
        projectName: "failed-api",
        cwd: temporaryDirectory,
        templateDirectory,
        releaseManifest,
        install: () => {
          throw new Error("registry unavailable");
        },
      }),
    ).rejects.toThrow("could not create failed-api: registry unavailable");
    await expect(readFile(resolve(target, "package.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes to an explicitly empty current directory", async () => {
    const currentDirectory = resolve(temporaryDirectory, "reporting-api");
    await mkdir(currentDirectory);

    const result = await createOperationProject({
      projectName: ".",
      cwd: currentDirectory,
      currentDirectory: true,
      skipInstall: true,
      templateDirectory,
      releaseManifest,
    });

    expect(result.packageName).toBe("reporting-api");
    expect(JSON.parse(await readFile(resolve(currentDirectory, "package.json"), "utf8")).name).toBe(
      "reporting-api",
    );
  });

  it("rejects a non-empty current directory without changing it", async () => {
    const currentDirectory = resolve(temporaryDirectory, "occupied-api");
    await mkdir(currentDirectory);
    await writeFile(resolve(currentDirectory, "owned.txt"), "keep\n");

    await expect(
      createOperationProject({
        projectName: ".",
        cwd: currentDirectory,
        currentDirectory: true,
        skipInstall: true,
        templateDirectory,
        releaseManifest,
      }),
    ).rejects.toThrow("--current-dir requires an empty directory");
    await expect(readFile(resolve(currentDirectory, "owned.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("requires --current-dir when the project name is dot", async () => {
    await expect(
      createOperationProject({
        projectName: ".",
        cwd: temporaryDirectory,
        skipInstall: true,
        templateDirectory,
        releaseManifest,
      }),
    ).rejects.toThrow("project name `.` requires --current-dir");
  });

  it.each([
    "../escape",
    "Uppercase",
    "two--hyphens",
    "trailing-",
  ])("rejects unsafe project name %s", async (projectName) => {
    await expect(
      createOperationProject({
        projectName,
        cwd: temporaryDirectory,
        skipInstall: true,
        templateDirectory,
        releaseManifest,
      }),
    ).rejects.toBeInstanceOf(ScaffoldError);
  });

  it("does not overwrite an existing target", async () => {
    const target = resolve(temporaryDirectory, "existing-api");
    await mkdir(target);
    await writeFile(resolve(target, "owned.txt"), "keep\n");

    await expect(
      createOperationProject({
        projectName: "existing-api",
        cwd: temporaryDirectory,
        skipInstall: true,
        templateDirectory,
        releaseManifest,
      }),
    ).rejects.toThrow("target already exists");
    await expect(readFile(resolve(target, "owned.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("validates the release manifest before scaffolding", async () => {
    const manifestPath = resolve(temporaryDirectory, "release-manifest.json");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2 }));

    await expect(loadScaffoldReleaseManifest(manifestPath)).rejects.toThrow(
      "invalid scaffold release manifest",
    );
  });

  it("loads a valid release manifest", async () => {
    const manifestPath = resolve(temporaryDirectory, "release-manifest.json");
    await writeFile(manifestPath, JSON.stringify(releaseManifest));

    await expect(loadScaffoldReleaseManifest(manifestPath)).resolves.toEqual(releaseManifest);
  });

  it("reports unreadable release manifests as scaffold errors", async () => {
    await expect(
      loadScaffoldReleaseManifest(resolve(temporaryDirectory, "missing.json")),
    ).rejects.toThrow("could not read the scaffold release manifest");
  });

  it.each([
    { ...releaseManifest, packageManager: 10 },
    { ...releaseManifest, packages: null },
    { ...releaseManifest, dependencies: [] },
    { ...releaseManifest, devDependencies: { vitest: 4 } },
  ])("rejects malformed release manifest fields %#", async (value) => {
    const manifestPath = resolve(temporaryDirectory, "invalid-release-manifest.json");
    await writeFile(manifestPath, JSON.stringify(value));

    await expect(loadScaffoldReleaseManifest(manifestPath)).rejects.toThrow(
      "invalid scaffold release manifest",
    );
  });
});
