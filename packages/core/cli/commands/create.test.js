import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getBundledDependencyVersion, validateProjectName } from "./create.js";

const templateDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/default",
);

describe("create — validateProjectName (F17)", () => {
  it("accepts npm-compatible names", () => {
    expect(validateProjectName("my-app")).toBeNull();
    expect(validateProjectName("MyApp")).toBeNull();
    expect(validateProjectName("my_app")).toBeNull();
    expect(validateProjectName("my-app-123")).toBeNull();
    expect(validateProjectName("a")).toBeNull();
  });

  it("rejects path-traversal-looking names", () => {
    expect(validateProjectName("..")).toMatch(/must not contain/);
    expect(validateProjectName("../etc/foo")).toMatch(/must not contain/);
    expect(validateProjectName("foo/../bar")).toMatch(/must not contain/);
  });

  it("rejects path separators", () => {
    expect(validateProjectName("foo/bar")).toMatch(/must not contain/);
    expect(validateProjectName("foo\\bar")).toMatch(/must not contain/);
  });

  it("rejects null bytes", () => {
    expect(validateProjectName("foo\0bar")).toMatch(/must not contain/);
  });

  it("rejects names that start with a digit (npm rule)", () => {
    expect(validateProjectName("123app")).toMatch(/npm-package-name/);
  });

  it("rejects names with disallowed characters (spaces, symbols)", () => {
    expect(validateProjectName("my app")).toMatch(/npm-package-name/);
    expect(validateProjectName("my@app")).toMatch(/npm-package-name/);
    expect(validateProjectName("my.app")).toMatch(/npm-package-name/);
    expect(validateProjectName("my(app)")).toMatch(/npm-package-name/);
  });

  it("rejects `..` (parent-dir traversal), regardless of where it appears", () => {
    expect(validateProjectName("..")).toMatch(/must not contain/);
    expect(validateProjectName("foo..bar")).toMatch(/must not contain/);
    expect(validateProjectName("..foo")).toMatch(/must not contain/);
  });

  it("rejects empty / non-string inputs", () => {
    expect(validateProjectName("")).toMatch(/non-empty/);
    expect(validateProjectName(undefined)).toMatch(/non-empty/);
    expect(validateProjectName(null)).toMatch(/non-empty/);
    expect(validateProjectName(42)).toMatch(/non-empty/);
  });

  it("rejects names that start with a dot (hidden / dotfile collision)", () => {
    expect(validateProjectName(".my-app")).toMatch(/npm-package-name/);
  });

  it("accepts names that contain (but don't start with) an uppercase letter or underscore", () => {
    expect(validateProjectName("a_b")).toBeNull();
    expect(validateProjectName("a-B")).toBeNull();
    expect(validateProjectName("aB123")).toBeNull();
  });
});

describe("create — process bootstrap", () => {
  it("loads application dependencies only after instrumentation starts", async () => {
    const [indexSource, instrumentationSource, serverSource] = await Promise.all([
      fs.readFile(path.join(templateDirectory, "src/index.ts"), "utf8"),
      fs.readFile(path.join(templateDirectory, "src/instrumentation.ts"), "utf8"),
      fs.readFile(path.join(templateDirectory, "src/server.ts"), "utf8"),
    ]);

    expect(indexSource).toContain('import "./instrumentation.js"');
    expect(indexSource).toContain('await import("./server.js")');
    expect(indexSource).not.toMatch(/from "@hono|from "@sixthsummit\/ship-api"/);
    expect(instrumentationSource).toContain("startOtel({");
    expect(instrumentationSource).not.toMatch(/@hono|\.\/server|\.\/environment/);
    expect(serverSource).toContain('from "@hono/node-server"');
  });

  it("pins the extracted observability package to its workspace release", async () => {
    const observabilityPackage = JSON.parse(
      await fs.readFile(
        path.resolve(templateDirectory, "../../../observability-otel/package.json"),
      ),
    );

    await expect(
      getBundledDependencyVersion("@sixthsummit/ship-observability-otel", "observability-otel"),
    ).resolves.toBe(`^${observabilityPackage.version}`);
  });
});
