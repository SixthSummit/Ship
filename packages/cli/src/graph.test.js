import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __test,
  affectedApplication,
  checkApplication,
  GRAPH_CLI_EXIT,
  GraphCliError,
  inspectApplication,
  runGraphCommand,
} from "./graph.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const cliPath = resolve(packageDirectory, "src/bin.js");
const legacyCliPath = resolve(packageDirectory, "../core/cli/ship-api.js");
const fixtureDirectory = resolve(sourceDirectory, "__fixtures__/graph");
const fixtureApp = resolve(fixtureDirectory, "ship.config.ts");
const invalidFixtureApp = resolve(fixtureDirectory, "invalid.config.ts");

describe("Ship application graph CLI", () => {
  let temporaryDirectory;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "ship-api-graph-cli-test-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it("loads a TypeScript app module and returns its deterministic graph", async () => {
    const first = await checkApplication({ cwd: fixtureDirectory });
    const second = await checkApplication({ cwd: fixtureDirectory });

    expect(first.graph.appId).toBe("graph-fixture");
    expect(first.graph.operations.map(({ id }) => id)).toEqual(["accounts.read"]);
    expect(JSON.stringify(second.graph)).toBe(JSON.stringify(first.graph));
  });

  it("emits .ship/graph.json as stable machine-readable output", async () => {
    const target = resolve(temporaryDirectory, ".ship/graph.json");
    const result = await checkApplication({ appPath: fixtureApp, emit: target });

    expect(result.emitted).toBe(target);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(result.graph);
  });

  it("inspects app, module, operation, and provider nodes", async () => {
    const options = { appPath: fixtureApp };
    const appResult = await inspectApplication("app", undefined, options);
    const moduleResult = await inspectApplication("module", "accounts", options);
    const operationResult = await inspectApplication("operation", "accounts.read", options);
    const providerResult = await inspectApplication("provider", "platform.clock", options);

    const channelResult = await inspectApplication("channel", "accounts.activity", options);

    expect(appResult.node.appId).toBe("graph-fixture");
    expect(moduleResult.node.imports).toEqual(["platform"]);
    expect(moduleResult.node.channels).toEqual(["accounts.activity"]);
    expect(operationResult.node.transport.binding).toBe("GET /accounts/:accountId");
    expect(operationResult.node.publishes).toEqual(["accounts.activity"]);
    expect(providerResult.node.lifetime).toBe("singleton");
    expect(channelResult.node).toEqual({
      id: "accounts.activity",
      moduleId: "accounts",
      scope: "actor",
      payload: { vendor: "zod", projectable: true },
      presence: false,
      slowSubscriber: "drop-oldest",
      publishers: ["accounts.read"],
    });
    expect(JSON.stringify(channelResult.node)).not.toMatch(/room|namespace|socket/iu);
  });

  it("projects the operations affected by a channel", async () => {
    const fromChannel = await affectedApplication("channel", "accounts.activity", {
      appPath: fixtureApp,
    });
    expect(fromChannel.affected).toEqual({
      modules: ["accounts"],
      operations: ["accounts.read"],
      providers: [],
    });
  });

  it("projects transitive affected surfaces from modules and providers", async () => {
    const options = { appPath: fixtureApp };
    const fromModule = await affectedApplication("module", "platform", options);
    const fromProvider = await affectedApplication("provider", "platform.clock", options);

    expect(fromModule.affected).toEqual({
      modules: ["accounts", "platform"],
      operations: ["accounts.read"],
      providers: ["accounts.activity.publish", "platform.clock"],
    });
    expect(fromProvider.affected).toEqual({
      modules: ["accounts", "platform"],
      operations: ["accounts.read"],
      providers: ["platform.clock"],
    });
  });

  it("projects bounded operation and complete application impact", async () => {
    const options = { appPath: fixtureApp };
    const operation = await affectedApplication("operation", "accounts.read", options);
    const application = await affectedApplication("app", "graph-fixture", options);

    expect(operation.affected).toEqual({
      modules: ["accounts"],
      operations: ["accounts.read"],
      providers: [],
    });
    expect(application.affected).toEqual({
      modules: ["accounts", "platform"],
      operations: ["accounts.read"],
      providers: ["accounts.activity.publish", "platform.clock"],
    });
  });

  it("uses exit 1 and preserves compiler diagnostics for an invalid application", async () => {
    const invalidApp = resolve(temporaryDirectory, "invalid-app.mjs");
    await writeFile(
      invalidApp,
      `throw Object.assign(new Error("invalid"), { diagnostics: [{ code: "SHIP_PROVIDER_MISSING", severity: "error", message: "missing", hint: "bind it" }] });`,
    );
    const io = captureIo();

    const exitCode = await runGraphCommand(
      () => checkApplication({ appPath: invalidApp }),
      { format: "json" },
      io,
    );

    expect(exitCode).toBe(GRAPH_CLI_EXIT.applicationInvalid);
    expect(io.output.stdout).toBe("");
    expect(JSON.parse(io.output.stderr).diagnostics[0].code).toBe("SHIP_PROVIDER_MISSING");
  });

  it("uses exit 2 with a stable diagnostic when the app export is missing", async () => {
    const invalidApp = resolve(temporaryDirectory, "missing-export.mjs");
    await writeFile(invalidApp, "export const nope = true;\n");
    const io = captureIo();

    const exitCode = await runGraphCommand(
      () => checkApplication({ appPath: invalidApp }),
      { format: "json" },
      io,
    );

    expect(exitCode).toBe(GRAPH_CLI_EXIT.usageOrLoadError);
    expect(JSON.parse(io.output.stderr).diagnostics[0].code).toBe("SHIP_CLI_APP_EXPORT_MISSING");
  });

  it("rejects unknown nodes with an actionable diagnostic", async () => {
    await expect(
      inspectApplication("operation", "accounts.missing", { appPath: fixtureApp }),
    ).rejects.toMatchObject({
      exitCode: 2,
      diagnostics: [{ code: "SHIP_CLI_GRAPH_NODE_NOT_FOUND" }],
    });
  });

  it("rejects invalid graph kinds, missing ids, and mismatched app ids", async () => {
    await expect(
      inspectApplication("table", "accounts", { appPath: fixtureApp }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "SHIP_CLI_GRAPH_KIND_INVALID" }],
    });
    await expect(
      inspectApplication("module", undefined, { appPath: fixtureApp }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "SHIP_CLI_GRAPH_ID_REQUIRED" }],
    });
    await expect(
      inspectApplication("app", "another-app", { appPath: fixtureApp }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "SHIP_CLI_GRAPH_NODE_NOT_FOUND" }],
    });
  });

  it("rejects unsupported formats before loading an application", async () => {
    const io = captureIo();
    let called = false;

    const exitCode = await runGraphCommand(
      async () => {
        called = true;
      },
      { format: "yaml" },
      io,
    );

    expect(called).toBe(false);
    expect(exitCode).toBe(GRAPH_CLI_EXIT.usageOrLoadError);
    expect(io.output.stderr).toContain("SHIP_CLI_FORMAT_INVALID");
  });

  it("normalizes load failures and invalid app-shaped exports", async () => {
    const throwingApp = resolve(temporaryDirectory, "throwing-app.mjs");
    const invalidShape = resolve(temporaryDirectory, "invalid-shape.mjs");
    await writeFile(throwingApp, 'throw new Error("dependency exploded");\n');
    await writeFile(invalidShape, 'export const app = { kind: "not-ship" };\n');

    await expect(checkApplication({ appPath: throwingApp })).rejects.toMatchObject({
      diagnostics: [{ code: "SHIP_CLI_APP_LOAD_FAILED" }],
    });
    await expect(checkApplication({ appPath: invalidShape })).rejects.toMatchObject({
      diagnostics: [{ code: "SHIP_CLI_APP_EXPORT_INVALID" }],
    });
  });

  it("renders stable human summaries for every result category", async () => {
    const io = captureIo();
    const options = { appPath: fixtureApp };
    const commands = [
      () => checkApplication(options),
      () => inspectApplication("app", undefined, options),
      () => inspectApplication("module", "accounts", options),
      () => inspectApplication("operation", "accounts.read", options),
      () => inspectApplication("provider", "platform.clock", options),
      () => affectedApplication("provider", "platform.clock", options),
    ];

    for (const command of commands) {
      expect(await runGraphCommand(command, { format: "human" }, io)).toBe(0);
    }
    expect(io.output.stdout).toContain("OK graph-fixture");
    expect(io.output.stdout).toContain("operation accounts.read");
    expect(io.output.stdout).toContain("provider platform.clock");
    expect(io.output.stdout).toContain("modules: accounts, platform");
  });

  it("runs check, inspect, and affected through the actual CLI entrypoint", () => {
    const commands = [
      ["check", "--app", fixtureApp, "--format", "json"],
      ["inspect", "operation", "accounts.read", "--app", fixtureApp, "--format", "json"],
      ["affected", "provider", "platform.clock", "--app", fixtureApp, "--format", "json"],
    ];

    for (const args of commands) {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: packageDirectory,
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
    }
  });

  it("returns stable process exit classes from the actual CLI entrypoint", () => {
    const invalidApplication = spawnSync(
      process.execPath,
      [cliPath, "check", "--app", invalidFixtureApp, "--format", "json"],
      { cwd: packageDirectory, encoding: "utf8" },
    );
    const missingApplication = spawnSync(
      process.execPath,
      [cliPath, "check", "--app", resolve(temporaryDirectory, "missing.ts"), "--format", "json"],
      { cwd: packageDirectory, encoding: "utf8" },
    );

    expect(invalidApplication.status).toBe(GRAPH_CLI_EXIT.applicationInvalid);
    expect(JSON.parse(invalidApplication.stderr).diagnostics[0].code).toBe(
      "SHIP_MODULE_ID_DUPLICATE",
    );
    expect(missingApplication.status).toBe(GRAPH_CLI_EXIT.usageOrLoadError);
    expect(JSON.parse(missingApplication.stderr).diagnostics[0].code).toBe(
      "SHIP_CLI_APP_NOT_FOUND",
    );
  });

  it("exposes GraphCliError for programmatic tooling", () => {
    const error = new GraphCliError([
      { code: "TEST", severity: "error", message: "bad", hint: "fix" },
    ]);
    expect(error).toMatchObject({ name: "GraphCliError", exitCode: 2 });
    expect(Object.isFrozen(error.diagnostics)).toBe(true);
  });

  it("keeps graph commands available through the legacy monolith CLI", () => {
    const result = spawnSync(
      process.execPath,
      [legacyCliPath, "check", "--app", fixtureApp, "--format", "json"],
      { cwd: packageDirectory, encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "check", ok: true });
  });
});

function captureIo() {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    stdout: (value) => {
      output.stdout += value;
    },
    stderr: (value) => {
      output.stderr += value;
    },
  };
}

describe("cache tag edges", () => {
  const graph = {
    schemaVersion: 1,
    appId: "cache-fixture",
    modules: [],
    providers: [],
    outboxes: [],
    channels: [],
    operations: [
      {
        id: "widgets.rename",
        moduleId: "widgets",
        invalidates: ["widgets"],
        dependencies: [],
        errors: [],
        access: { kind: "authenticated" },
        transaction: "write",
      },
      {
        id: "widgets.list",
        moduleId: "widgets",
        cache: { ttlMs: 1000, scope: "public", tags: ["widgets"], varies: false },
        dependencies: [],
        errors: [],
        access: { kind: "public" },
        transaction: "none",
      },
      {
        id: "gadgets.list",
        moduleId: "gadgets",
        cache: { ttlMs: 1000, scope: "public", tags: ["gadgets"], varies: false },
        dependencies: [],
        errors: [],
        access: { kind: "public" },
        transaction: "none",
      },
    ],
  };

  it("follows an invalidating write to the cached reads it purges", () => {
    expect(__test.affectedByOperation(graph, graph.operations[0])).toEqual({
      modules: ["widgets"],
      operations: ["widgets.list", "widgets.rename"],
      providers: [],
    });
  });

  it("leaves a cached read bounded to itself", () => {
    expect(__test.affectedByOperation(graph, graph.operations[1])).toEqual({
      modules: ["widgets"],
      operations: ["widgets.list"],
      providers: [],
    });
  });

  it("renders the declared policy and tag edges in inspect output", () => {
    const rendered = __test.renderSuccess(
      { command: "inspect", kind: "operation", node: graph.operations[1] },
      "human",
    );
    expect(rendered).toContain("cache: public ttl=1000ms tags=widgets");
    expect(rendered).toContain("invalidates: (none)");
    expect(
      __test.renderSuccess(
        { command: "inspect", kind: "operation", node: graph.operations[0] },
        "human",
      ),
    ).toContain("invalidates: widgets");
    expect(
      __test.renderSuccess(
        {
          command: "inspect",
          kind: "operation",
          node: {
            ...graph.operations[0],
            invalidates: ["gadgets", "widgets"],
            invalidatesScoped: [{ tag: "widgets", scope: "tenant" }],
          },
        },
        "human",
      ),
    ).toContain("invalidates: gadgets, widgets (tenant)");
  });

  it("lists declared and framework-introduced permissions for an app or module", () => {
    const permissioned = {
      ...graph,
      modules: [...graph.modules, { id: "jobs", imports: [], operations: [], providers: [] }],
      operations: [
        ...graph.operations,
        {
          id: "widgets.archive",
          moduleId: "widgets",
          dependencies: [],
          errors: [],
          access: { kind: "permissions", mode: "all", permissions: ["widgets:write"] },
          transaction: "write",
        },
        {
          id: "jobs.retry",
          moduleId: "jobs",
          dependencies: [],
          errors: [],
          access: { kind: "permissions", mode: "all", permissions: ["ship.jobs:manage"] },
          transaction: "none",
        },
      ],
      jobs: [
        {
          id: "widgets.render",
          moduleId: "widgets",
          trigger: {
            kind: "http",
            access: { kind: "permissions", mode: "all", permissions: ["jobs:trigger:render"] },
          },
        },
      ],
    };
    expect(__test.projectPermissions(permissioned, undefined)).toEqual([
      { permission: "jobs:trigger:render", framework: false, operations: ["widgets.render"] },
      { permission: "ship.jobs:manage", framework: true, operations: ["jobs.retry"] },
      { permission: "widgets:write", framework: false, operations: ["widgets.archive"] },
    ]);
    expect(
      __test.projectPermissions(permissioned, "widgets").map((item) => item.permission),
    ).toEqual(["jobs:trigger:render", "widgets:write"]);
    const rendered = __test.renderSuccess(
      {
        command: "inspect",
        kind: "module",
        node: { id: "jobs", imports: [], operations: ["jobs.retry"], providers: [], exports: [] },
        permissions: __test.projectPermissions(permissioned, "jobs"),
      },
      "human",
    );
    expect(rendered).toContain("permissions: (none)");
    expect(rendered).toContain("framework permissions: ship.jobs:manage (jobs.retry)");
  });

  it("surfaces compilation warnings in check output", () => {
    const rendered = __test.renderSuccess(
      {
        command: "check",
        graph: {
          ...graph,
          diagnostics: [
            { code: "SHIP_CACHE_TAG_UNKNOWN", severity: "warning", message: "no reader", hint: "" },
          ],
        },
      },
      "human",
    );
    expect(rendered).toContain("warnings: 1");
    expect(rendered).toContain("SHIP_CACHE_TAG_UNKNOWN: no reader");
  });
});

describe("Ship application graph CLI jobs", () => {
  const jobsApp = resolve(fixtureDirectory, "jobs.config.ts");
  const invalidJobApp = resolve(fixtureDirectory, "invalid-job.config.ts");

  it("checks an application with jobs and reports compiler warnings", async () => {
    const result = await checkApplication({ appPath: jobsApp });
    expect(result.graph.jobs.map(({ id }) => id)).toEqual([
      "reports.digest",
      "reports.render",
      "reports.sweep",
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "SHIP_JOB_SINGLE_RUNNER_UNKEYED",
        severity: "warning",
        operationId: "reports.sweep",
      }),
    ]);
    const io = captureIo();
    expect(await runGraphCommand(() => checkApplication({ appPath: jobsApp }), {}, io)).toBe(0);
    expect(io.output.stdout).toContain("3 jobs");
    expect(io.output.stdout).toContain("WARN SHIP_JOB_SINGLE_RUNNER_UNKEYED [reports.sweep]");
  });

  it("inspects jobs and job-related operations", async () => {
    const options = { appPath: jobsApp };
    const job = await inspectApplication("job", "reports.digest", options);
    expect(job.node).toMatchObject({
      moduleId: "reports",
      trigger: { kind: "schedule", cron: "0 6 * * *", tz: "UTC" },
      concurrency: { mode: "single-runner", keyed: true },
      enqueues: ["reports.render"],
    });
    const io = captureIo();
    for (const [kind, id] of [
      ["job", "reports.digest"],
      ["job", "reports.sweep"],
      ["job", "reports.render"],
      ["operation", "reports.digest"],
      ["operation", "jobs.retry"],
    ]) {
      expect(await runGraphCommand(() => inspectApplication(kind, id, options), {}, io)).toBe(0);
    }
    expect(io.output.stdout).toContain("trigger: schedule 0 6 * * * (UTC)");
    expect(io.output.stdout).toContain(
      "concurrency: single-runner max=1 unkeyed (one sweep covers every tenant)",
    );
    expect(io.output.stdout).toContain("trigger: interval 60000ms");
    expect(io.output.stdout).toContain("job: enqueue reports.render, job reports.digest");
    expect(io.output.stdout).toContain("job: management retry");

    // Mounting defineJobManagement() introduces a framework permission the
    // consumer must grant; inspect names it at app and module level.
    const module = await inspectApplication("module", "jobs", options);
    expect(module.permissions).toEqual([
      {
        permission: "ship.jobs:manage",
        framework: true,
        operations: ["jobs.discard", "jobs.health", "jobs.list-failed", "jobs.retry"],
      },
    ]);
    const app = await inspectApplication("app", undefined, options);
    expect(app.permissions.map((item) => item.permission)).toContain("ship.jobs:manage");
    const moduleIo = captureIo();
    expect(
      await runGraphCommand(() => inspectApplication("module", "jobs", options), {}, moduleIo),
    ).toBe(0);
    expect(moduleIo.output.stdout).toContain(
      "framework permissions: ship.jobs:manage (jobs.discard, jobs.health, jobs.list-failed, jobs.retry)",
    );
    await expect(inspectApplication("job", "reports.missing", options)).rejects.toMatchObject({
      diagnostics: [{ code: "SHIP_CLI_GRAPH_NODE_NOT_FOUND" }],
    });
  });

  it("treats jobs as operations for affected surfaces", async () => {
    const options = { appPath: jobsApp };
    const fromJob = await affectedApplication("job", "reports.digest", options);
    const fromOperation = await affectedApplication("operation", "reports.digest", options);
    expect(fromJob.affected).toEqual({
      modules: ["reports"],
      operations: ["reports.digest"],
      providers: [],
    });
    expect(fromJob.affected).toEqual(fromOperation.affected);
  });

  it("surfaces declaration errors as exit-1 diagnostics", async () => {
    const io = captureIo();
    const exitCode = await runGraphCommand(
      () => checkApplication({ appPath: invalidJobApp }),
      { format: "json" },
      io,
    );
    expect(exitCode).toBe(GRAPH_CLI_EXIT.applicationInvalid);
    expect(JSON.parse(io.output.stderr).diagnostics[0]).toMatchObject({
      code: "SHIP_JOB_SCHEDULE_TZ_REQUIRED",
      operationId: "reports.digest",
      path: "trigger.tz",
    });
  });
});
