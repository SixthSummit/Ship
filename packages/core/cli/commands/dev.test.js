import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test } from "./dev.js";

let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ship-api-dev-test-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("findComposeFile", () => {
  it("returns null when no compose file is present", async () => {
    expect(await __test.findComposeFile(dir)).toBeNull();
  });

  it("prefers compose.yml over docker-compose.yml when both exist", async () => {
    await fs.writeFile(path.join(dir, "compose.yml"), "services:\n");
    await fs.writeFile(path.join(dir, "docker-compose.yml"), "services:\n");
    expect(await __test.findComposeFile(dir)).toBe("compose.yml");
  });

  it("falls back to docker-compose.yml when compose.yml is absent", async () => {
    await fs.writeFile(path.join(dir, "docker-compose.yml"), "services:\n");
    expect(await __test.findComposeFile(dir)).toBe("docker-compose.yml");
  });

  it("recognizes .yaml variants", async () => {
    await fs.writeFile(path.join(dir, "docker-compose.yaml"), "services:\n");
    expect(await __test.findComposeFile(dir)).toBe("docker-compose.yaml");
  });
});

describe("selectExistingServices", () => {
  it("returns only the candidates that appear as top-level service keys", async () => {
    const compose = `services:
  postgres:
    image: postgres:16
  redis:
    image: redis:7
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
`;
    await fs.writeFile(path.join(dir, "compose.yml"), compose);
    const services = await __test.selectExistingServices("compose.yml", dir, [
      "postgres",
      "redis",
      "otel-collector",
      "rabbitmq", // not in the file — should be filtered out
    ]);
    expect(services).toEqual(["postgres", "redis", "otel-collector"]);
  });

  it("returns an empty array when no candidates match", async () => {
    const compose = `services:
  someotherservice:
    image: scratch
`;
    await fs.writeFile(path.join(dir, "compose.yml"), compose);
    const services = await __test.selectExistingServices("compose.yml", dir, ["postgres", "redis"]);
    expect(services).toEqual([]);
  });

  it("does not match service names that appear inside an indented block", async () => {
    // Defense against false positives where `postgres:` appears as a value
    // (e.g., in env or a healthcheck command), not a top-level service key.
    const compose = `services:
  api:
    environment:
      DEPENDENCY: postgres
      DEPENDENCY_NAME: redis
`;
    await fs.writeFile(path.join(dir, "compose.yml"), compose);
    const services = await __test.selectExistingServices("compose.yml", dir, ["postgres", "redis"]);
    expect(services).toEqual([]);
  });
});

describe("pickDevScript", () => {
  async function writePkg(scripts) {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "test", scripts }, null, 2),
    );
  }

  it("prefers `dev` over `local`", async () => {
    await writePkg({ dev: "tsx watch src/index.ts", local: "tsx watch src/index.ts" });
    expect(await __test.pickDevScript(dir)).toBe("dev");
  });

  it("falls back to `local` when no `dev`", async () => {
    await writePkg({ local: "tsx watch src/index.ts" });
    expect(await __test.pickDevScript(dir)).toBe("local");
  });

  it("falls back to `start` when neither dev nor local exist", async () => {
    await writePkg({ start: "node dist/index.js" });
    expect(await __test.pickDevScript(dir)).toBe("start");
  });

  it("defaults to `local` when package.json is missing or malformed", async () => {
    expect(await __test.pickDevScript(dir)).toBe("local");
    await fs.writeFile(path.join(dir, "package.json"), "{ broken json");
    expect(await __test.pickDevScript(dir)).toBe("local");
  });
});
