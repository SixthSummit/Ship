import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test } from "./doctor.js";

describe("ship-api g doctor — internal helpers", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-doctor-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("checkProjectStructure", () => {
    it("fails when package.json is missing", async () => {
      const result = await __test.checkProjectStructure(tmp);
      expect(result).toMatchObject({
        name: "project_structure",
        status: "fail",
      });
      expect(result.detail).toMatch(/not found/);
    });

    it("warns when @sixthsummit/ship-api is not declared", async () => {
      await writeFile(
        path.join(tmp, "package.json"),
        JSON.stringify({ name: "x", dependencies: {} }),
      );
      const result = await __test.checkProjectStructure(tmp);
      expect(result.status).toBe("warn");
    });

    it("ok when @sixthsummit/ship-api is in dependencies", async () => {
      await writeFile(
        path.join(tmp, "package.json"),
        JSON.stringify({
          name: "x",
          dependencies: { "@sixthsummit/ship-api": "^4.0.0" },
        }),
      );
      const result = await __test.checkProjectStructure(tmp);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("^4.0.0");
    });

    it("ok when @sixthsummit/ship-api is in devDependencies", async () => {
      await writeFile(
        path.join(tmp, "package.json"),
        JSON.stringify({
          name: "x",
          devDependencies: { "@sixthsummit/ship-api": "4.0.1" },
        }),
      );
      const result = await __test.checkProjectStructure(tmp);
      expect(result.status).toBe("ok");
    });
  });

  describe("checkEnvVars", () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("warns when modules/ directory is missing", async () => {
      const results = await __test.checkEnvVars(tmp);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        name: "env_vars",
        status: "warn",
      });
    });

    it("ok when no required vars are declared", async () => {
      await mkdir(path.join(tmp, "modules", "me"), { recursive: true });
      await writeFile(
        path.join(tmp, "modules", "me", "module.json"),
        JSON.stringify({ name: "me", requiredEnvVars: [] }),
      );
      const results = await __test.checkEnvVars(tmp);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        name: "env_vars.me",
        status: "ok",
      });
    });

    it("ok when all required vars are set in process.env", async () => {
      await mkdir(path.join(tmp, "modules", "auth"), { recursive: true });
      await writeFile(
        path.join(tmp, "modules", "auth", "module.json"),
        JSON.stringify({
          name: "auth",
          requiredEnvVars: ["JWT_SIGNING_KEY", "JWT_VERIFICATION_KEYS"],
        }),
      );
      process.env.JWT_SIGNING_KEY = "x";
      process.env.JWT_VERIFICATION_KEYS = "y";
      const results = await __test.checkEnvVars(tmp);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("ok");
    });

    it("fails when required vars are missing — names listed in detail", async () => {
      await mkdir(path.join(tmp, "modules", "auth"), { recursive: true });
      await writeFile(
        path.join(tmp, "modules", "auth", "module.json"),
        JSON.stringify({
          name: "auth",
          requiredEnvVars: ["MISSING_A", "MISSING_B"],
        }),
      );
      delete process.env.MISSING_A;
      delete process.env.MISSING_B;
      const results = await __test.checkEnvVars(tmp);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("fail");
      expect(results[0].detail).toContain("MISSING_A");
      expect(results[0].detail).toContain("MISSING_B");
    });

    it("aggregates per-module results when multiple modules exist", async () => {
      await mkdir(path.join(tmp, "modules", "ok-mod"), { recursive: true });
      await mkdir(path.join(tmp, "modules", "bad-mod"), { recursive: true });
      await writeFile(
        path.join(tmp, "modules", "ok-mod", "module.json"),
        JSON.stringify({ name: "ok-mod", requiredEnvVars: [] }),
      );
      await writeFile(
        path.join(tmp, "modules", "bad-mod", "module.json"),
        JSON.stringify({
          name: "bad-mod",
          requiredEnvVars: ["MUST_BE_PRESENT"],
        }),
      );
      delete process.env.MUST_BE_PRESENT;
      const results = await __test.checkEnvVars(tmp);
      expect(results).toHaveLength(2);
      const okResult = results.find((r) => r.name === "env_vars.ok-mod");
      const badResult = results.find((r) => r.name === "env_vars.bad-mod");
      expect(okResult.status).toBe("ok");
      expect(badResult.status).toBe("fail");
    });

    it("skips directories without a module.json", async () => {
      await mkdir(path.join(tmp, "modules", "stub"), { recursive: true });
      const results = await __test.checkEnvVars(tmp);
      expect(results).toHaveLength(1);
      // Falls back to "no manifests" warn.
      expect(results[0]).toMatchObject({
        name: "env_vars",
        status: "warn",
      });
    });
  });

  describe("checkDrizzleMigrations", () => {
    it("warns when neither config nor migrations exist", async () => {
      const result = await __test.checkDrizzleMigrations(tmp);
      expect(result).toMatchObject({
        name: "drizzle_migrations",
        status: "warn",
      });
      expect(result.detail).toMatch(/not configured/);
    });

    it("warns when drizzle.config exists but no migrations", async () => {
      await writeFile(path.join(tmp, "drizzle.config.ts"), "export default {};");
      const result = await __test.checkDrizzleMigrations(tmp);
      expect(result.status).toBe("warn");
      expect(result.detail).toMatch(/db:generate/);
    });

    it("ok when migrations exist (counts .sql files)", async () => {
      await mkdir(path.join(tmp, "src", "db", "migrations"), {
        recursive: true,
      });
      await writeFile(path.join(tmp, "src", "db", "migrations", "0001_init.sql"), "-- migration");
      await writeFile(path.join(tmp, "src", "db", "migrations", "0002_users.sql"), "-- migration");
      // A non-sql file in the same directory should not be counted.
      await writeFile(path.join(tmp, "src", "db", "migrations", "meta.json"), "{}");
      const result = await __test.checkDrizzleMigrations(tmp);
      expect(result.status).toBe("ok");
      expect(result.detail).toMatch(/2 migration files/);
    });
  });
});
