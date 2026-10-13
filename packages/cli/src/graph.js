import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

/** @typedef {import("@sixthsummit/ship-core").AnyModule} AnyModule */
/** @typedef {import("@sixthsummit/ship-core").ApplicationGraph} ApplicationGraph */
/** @typedef {import("@sixthsummit/ship-core").CompiledApplication<string, readonly AnyModule[]>} LoadedApplication */
/** @typedef {import("@sixthsummit/ship-core").ModuleGraphNode | import("@sixthsummit/ship-core").OperationGraphNode | import("@sixthsummit/ship-core").ProviderGraphNode | import("@sixthsummit/ship-core").ChannelGraphNode | import("@sixthsummit/ship-core").JobGraphNode | ApplicationGraph} GraphNode */
/** @typedef {"human" | "json"} GraphOutputFormat */
/** @typedef {"app" | "module" | "operation" | "provider" | "channel" | "job"} GraphKind */
/** @typedef {0 | 1 | 2} GraphCliExitCode */
/**
 * @typedef {object} GraphCliDiagnostic
 * @property {string} code
 * @property {"error" | "warning"} severity
 * @property {string} message
 * @property {string} hint
 * @property {string=} appId
 * @property {string=} moduleId
 * @property {string=} operationId
 * @property {string=} providerId
 * @property {string=} path
 */
/**
 * @typedef {object} GraphCliOptions
 * @property {string=} cwd
 * @property {string=} appPath
 * @property {string=} emit
 * @property {GraphOutputFormat=} format
 */
/**
 * @typedef {object} AffectedGraphSurface
 * @property {readonly string[]} modules
 * @property {readonly string[]} operations
 * @property {readonly string[]} providers
 */
/**
 * @typedef {object} GraphIo
 * @property {(value: string) => unknown} stdout
 * @property {(value: string) => unknown} stderr
 */

export const GRAPH_CLI_EXIT = Object.freeze({
  success: 0,
  applicationInvalid: 1,
  usageOrLoadError: 2,
});

const DEFAULT_APP_PATH = "ship.config.ts";
const DEFAULT_GRAPH_PATH = ".ship/graph.json";
const GRAPH_FORMATS = new Set(["human", "json"]);
const GRAPH_KINDS = new Set(["app", "module", "operation", "provider", "channel", "job"]);
const DEFINITION_ERROR_PATTERN = /^SHIP_[A-Z0-9_]+$/u;

export class GraphCliError extends Error {
  /**
   * @param {readonly GraphCliDiagnostic[]} diagnostics
   * @param {GraphCliExitCode} [exitCode]
   * @param {ErrorOptions} [options]
   */
  constructor(diagnostics, exitCode = GRAPH_CLI_EXIT.usageOrLoadError, options) {
    super(diagnostics[0]?.message ?? "Ship graph command failed", options);
    this.name = "GraphCliError";
    this.diagnostics = Object.freeze(diagnostics.map((item) => Object.freeze({ ...item })));
    this.exitCode = exitCode;
  }
}

/**
 * @param {GraphCliOptions} [options]
 * @returns {Promise<LoadedApplication>}
 */
export async function loadApplication(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const appPath = resolve(cwd, options.appPath ?? DEFAULT_APP_PATH);

  try {
    await access(appPath);
  } catch (cause) {
    throw cliError(
      "SHIP_CLI_APP_NOT_FOUND",
      `application module was not found at ${JSON.stringify(appPath)}`,
      "Create ship.config.ts with a named `app` export or pass --app <path>.",
      { path: appPath },
      { cause },
    );
  }

  let loaded;
  try {
    loaded = await tsImport(pathToFileURL(appPath).href, import.meta.url);
  } catch (cause) {
    if (hasApplicationDiagnostics(cause)) {
      throw new GraphCliError(cause.diagnostics, GRAPH_CLI_EXIT.applicationInvalid, { cause });
    }
    const definitionError = definitionDiagnostic(cause);
    if (definitionError) {
      throw new GraphCliError([definitionError], GRAPH_CLI_EXIT.applicationInvalid, { cause });
    }
    throw cliError(
      "SHIP_CLI_APP_LOAD_FAILED",
      `application module ${JSON.stringify(appPath)} could not be loaded: ${safeErrorMessage(cause)}`,
      "Run the project's TypeScript check, then load only declaration-safe code from ship.config.ts.",
      { path: appPath },
      { cause },
    );
  }

  if (!("app" in loaded)) {
    throw cliError(
      "SHIP_CLI_APP_EXPORT_MISSING",
      `application module ${JSON.stringify(appPath)} has no named \`app\` export`,
      "Export the defineApp(...) result as `export const app = ...`.",
      { path: appPath },
    );
  }

  assertCompiledApplication(loaded.app, appPath);
  return loaded.app;
}

/**
 * @param {GraphCliOptions} [options]
 * @returns {Promise<Readonly<{command: "check", ok: true, graph: ApplicationGraph, emitted?: string}>>}
 */
export async function checkApplication(options = {}) {
  const application = await loadApplication(options);
  let emitted;
  if (options.emit !== undefined) {
    emitted = resolve(options.cwd ?? process.cwd(), options.emit || DEFAULT_GRAPH_PATH);
    await writeGraph(application.graph, emitted);
  }
  return Object.freeze({
    command: "check",
    ok: true,
    graph: application.graph,
    /** Non-fatal compiler diagnostics such as SHIP_JOB_SINGLE_RUNNER_UNKEYED. */
    warnings: Object.freeze([...(application.diagnostics ?? [])]),
    ...(emitted ? { emitted } : {}),
  });
}

/**
 * @param {GraphKind} kind
 * @param {string | undefined} id
 * @param {GraphCliOptions} [options]
 * @returns {Promise<Readonly<{command: "inspect", ok: true, kind: GraphKind, id: string, node: GraphNode}>>}
 */
export async function inspectApplication(kind, id, options = {}) {
  assertKind(kind);
  const { graph } = await loadApplication(options);
  const node = findNode(graph, kind, id);
  const nodeId = kind === "app" ? node.appId : node.id;
  return Object.freeze({
    command: "inspect",
    ok: true,
    kind,
    id: nodeId,
    node,
    ...(kind === "app" || kind === "module"
      ? { permissions: projectPermissions(graph, kind === "module" ? nodeId : undefined) }
      : {}),
  });
}

const FRAMEWORK_PERMISSION_PREFIX = "ship.";

/**
 * Every permission slug an app or module's operations (and HTTP job triggers)
 * demand, with the operations that demand it. A slug under `ship.` is
 * introduced by a framework module (`ship.outbox:manage`, `ship.jobs:manage`,
 * `ship.webhooks:replay`) and must be granted by the consumer's own
 * authorization model before those operations can be reached.
 *
 * @param {ApplicationGraph} graph
 * @param {string | undefined} moduleId
 * @returns {readonly Readonly<{permission: string, framework: boolean, operations: readonly string[]}>[]}
 */
function projectPermissions(graph, moduleId) {
  /** @type {Map<string, Set<string>>} */
  const operationsByPermission = new Map();
  const collect = (access, operationId) => {
    if (!access || access.kind !== "permissions") return;
    for (const permission of access.permissions) {
      const operations = operationsByPermission.get(permission) ?? new Set();
      operations.add(operationId);
      operationsByPermission.set(permission, operations);
    }
  };
  for (const operation of graph.operations) {
    if (moduleId && operation.moduleId !== moduleId) continue;
    collect(operation.access, operation.id);
  }
  for (const job of graph.jobs ?? []) {
    if (moduleId && job.moduleId !== moduleId) continue;
    if (job.trigger?.kind === "http") collect(job.trigger.access, job.id);
  }
  return Object.freeze(
    [...operationsByPermission]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([permission, operations]) =>
        Object.freeze({
          permission,
          framework: permission.startsWith(FRAMEWORK_PERMISSION_PREFIX),
          operations: Object.freeze([...operations].sort()),
        }),
      ),
  );
}

/**
 * @param {GraphKind} kind
 * @param {string | undefined} id
 * @param {GraphCliOptions} [options]
 * @returns {Promise<Readonly<{command: "affected", ok: true, kind: GraphKind, id: string, affected: AffectedGraphSurface}>>}
 */
export async function affectedApplication(kind, id, options = {}) {
  assertKind(kind);
  const { graph } = await loadApplication(options);
  const root = findNode(graph, kind, id);
  const rootId = kind === "app" ? root.appId : root.id;
  const affected = projectAffected(graph, kind, rootId);
  return Object.freeze({ command: "affected", ok: true, kind, id: rootId, affected });
}

/**
 * @param {() => Promise<unknown>} command
 * @param {{format?: GraphOutputFormat}} [options]
 * @param {GraphIo} [io]
 * @returns {Promise<GraphCliExitCode>}
 */
export async function runGraphCommand(command, options = {}, io = defaultIo()) {
  const format = options.format ?? "human";
  try {
    assertFormat(format);
    const result = await command();
    io.stdout(`${renderSuccess(result, format)}\n`);
    return GRAPH_CLI_EXIT.success;
  } catch (cause) {
    const error = normalizeGraphError(cause);
    io.stderr(`${renderFailure(error, format)}\n`);
    return error.exitCode;
  }
}

async function writeGraph(graph, target) {
  const directory = dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function assertCompiledApplication(value, path) {
  if (
    !isObject(value) ||
    value.kind !== "ship.application" ||
    typeof value.id !== "string" ||
    !isApplicationGraph(value.graph) ||
    value.id !== value.graph.appId
  ) {
    throw cliError(
      "SHIP_CLI_APP_EXPORT_INVALID",
      `named \`app\` export from ${JSON.stringify(path)} is not a compiled Ship application`,
      "Export the value returned by defineApp(...) or compileApp(...).",
      { path },
    );
  }
}

function isApplicationGraph(value) {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    typeof value.appId === "string" &&
    Array.isArray(value.modules) &&
    Array.isArray(value.operations) &&
    Array.isArray(value.providers) &&
    Array.isArray(value.channels)
  );
}

function assertFormat(format) {
  if (!GRAPH_FORMATS.has(format)) {
    throw cliError(
      "SHIP_CLI_FORMAT_INVALID",
      `unsupported output format ${JSON.stringify(format)}`,
      "Use --format human or --format json.",
      { path: "format" },
    );
  }
}

function assertKind(kind) {
  if (!GRAPH_KINDS.has(kind)) {
    throw cliError(
      "SHIP_CLI_GRAPH_KIND_INVALID",
      `unsupported graph kind ${JSON.stringify(kind)}`,
      "Use app, module, operation, provider, channel, or job.",
      { path: "kind" },
    );
  }
}

function findNode(graph, kind, id) {
  if (kind === "app") {
    if (id && id !== graph.appId) throw nodeNotFound(kind, id);
    return graph;
  }
  if (!id) {
    throw cliError(
      "SHIP_CLI_GRAPH_ID_REQUIRED",
      `${kind} inspection requires an id`,
      `Pass ship-api inspect ${kind} <id>.`,
      { path: "id" },
    );
  }
  const collection = graph[`${kind}s`];
  const node = collection.find((candidate) => candidate.id === id);
  if (!node) throw nodeNotFound(kind, id);
  return node;
}

function nodeNotFound(kind, id) {
  return cliError(
    "SHIP_CLI_GRAPH_NODE_NOT_FOUND",
    `${kind} ${JSON.stringify(id)} is not present in the application graph`,
    "Run ship-api check --format json and use an id from the current graph.",
    { [`${kind}Id`]: id },
  );
}

function projectAffected(graph, kind, id) {
  if (kind === "app") return allGraphIds(graph);
  if (kind === "operation" || kind === "job") {
    // Jobs are operations: the same bounded surface applies.
    const operation = findNode(graph, kind, id);
    return affectedByOperation(graph, operation);
  }
  if (kind === "module") return affectedByModule(graph, id);
  if (kind === "channel") {
    const channel = findNode(graph, kind, id);
    return freezeAffected([channel.moduleId], channel.publishers, []);
  }
  return affectedByProvider(graph, id);
}

/**
 * An operation affects itself, and a write affects every cached read it
 * invalidates: the declared tags are real graph edges, so a change to an
 * invalidating write reaches the reads whose entries it purges.
 */
function affectedByOperation(graph, operation) {
  const tags = new Set(operation.invalidates ?? []);
  const operations = [operation];
  if (tags.size > 0) {
    for (const candidate of graph.operations) {
      if (candidate.id === operation.id) continue;
      if ((candidate.cache?.tags ?? []).some((tag) => tags.has(tag))) operations.push(candidate);
    }
  }
  return freezeAffected(
    [...new Set(operations.map((item) => item.moduleId))],
    operations.map((item) => item.id),
    [],
  );
}

function affectedByModule(graph, id) {
  const modules = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of graph.modules) {
      if (!modules.has(module.id) && module.imports.some((item) => modules.has(item))) {
        modules.add(module.id);
        changed = true;
      }
    }
  }
  return freezeAffected(
    [...modules],
    graph.operations.filter((item) => modules.has(item.moduleId)).map((item) => item.id),
    graph.providers.filter((item) => modules.has(item.moduleId)).map((item) => item.id),
  );
}

function affectedByProvider(graph, id) {
  const providers = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const provider of graph.providers) {
      if (
        !providers.has(provider.id) &&
        provider.dependencies.some((item) => providers.has(item.providerId))
      ) {
        providers.add(provider.id);
        changed = true;
      }
    }
  }
  const operations = graph.operations
    .filter((item) => item.dependencies.some((dependency) => providers.has(dependency.providerId)))
    .map((item) => item.id);
  const operationIds = new Set(operations);
  const modules = graph.modules
    .filter(
      (module) =>
        module.providers.some((providerId) => providers.has(providerId)) ||
        module.operations.some((operationId) => operationIds.has(operationId)),
    )
    .map((module) => module.id);
  return freezeAffected(modules, operations, [...providers]);
}

function allGraphIds(graph) {
  return freezeAffected(
    graph.modules.map((item) => item.id),
    graph.operations.map((item) => item.id),
    graph.providers.map((item) => item.id),
  );
}

function freezeAffected(modules, operations, providers) {
  return Object.freeze({
    modules: Object.freeze([...modules].sort()),
    operations: Object.freeze([...operations].sort()),
    providers: Object.freeze([...providers].sort()),
  });
}

function renderSuccess(result, format) {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (result.command === "contract") {
    return [
      `OK ${result.appId} ${result.fingerprint}`,
      `${result.operations} operations`,
      `contract: ${result.contract}`,
      `openapi: ${result.openapi}`,
    ].join("\n");
  }
  if (result.command === "migrate-routes") {
    return [
      `OK ${result.appId} ${result.catalogRevision}`,
      `${result.routes} legacy routes · ${result.mapped} mapped · ${result.removed} removed`,
      `catalog: ${result.catalog}`,
      `mapping: ${result.mapping}`,
    ].join("\n");
  }
  if (result.command === "check") {
    const graph = result.graph;
    const jobs = graph.jobs ?? [];
    // Warnings are retained on the compiled application and mirrored onto the
    // graph; render one list whichever the caller supplied.
    const warnings = result.warnings ?? graph.diagnostics ?? [];
    return [
      `OK ${graph.appId}`,
      `${graph.modules.length} modules · ${graph.operations.length} operations · ${graph.providers.length} providers · ${graph.channels.length} channels · ${jobs.length} jobs`,
      ...(warnings.length ? [`warnings: ${warnings.length}`] : []),
      ...(result.emitted ? [`graph: ${result.emitted}`] : []),
      ...warnings.map((item) => {
        const subject = item.operationId ?? item.providerId ?? item.moduleId ?? item.path;
        return `WARN ${item.code}${subject ? ` [${subject}]` : ""}: ${item.message}\n  ${item.hint}`;
      }),
    ].join("\n");
  }
  if (result.command === "affected") {
    return [
      `${result.kind} ${result.id}`,
      `modules: ${displayIds(result.affected.modules)}`,
      `operations: ${displayIds(result.affected.operations)}`,
      `providers: ${displayIds(result.affected.providers)}`,
    ].join("\n");
  }
  return renderInspectedNode(result.kind, result.node, result.permissions);
}

function renderPermissions(permissions = []) {
  const declared = permissions.filter((item) => !item.framework);
  const framework = permissions.filter((item) => item.framework);
  return [
    `permissions: ${displayIds(declared.map((item) => item.permission))}`,
    `framework permissions: ${
      framework.length > 0
        ? framework.map((item) => `${item.permission} (${item.operations.join(", ")})`).join(", ")
        : "(none)"
    }`,
  ];
}

function renderInspectedNode(kind, node, permissions) {
  if (kind === "app") {
    return [
      `app ${node.appId}`,
      `${node.modules.length} modules · ${node.operations.length} operations · ${node.providers.length} providers`,
      ...renderPermissions(permissions),
    ].join("\n");
  }
  if (kind === "module") {
    return [
      `module ${node.id}`,
      `imports: ${displayIds(node.imports)}`,
      `operations: ${displayIds(node.operations)}`,
      `providers: ${displayIds(node.providers)}`,
      `exports: ${displayIds(node.exports)}`,
      ...renderPermissions(permissions),
    ].join("\n");
  }
  if (kind === "provider") {
    return [
      `provider ${node.id}`,
      `module: ${node.moduleId}`,
      `lifetime: ${node.lifetime}`,
      `dependencies: ${displayIds(node.dependencies.map((item) => item.providerId))}`,
    ].join("\n");
  }
  if (kind === "job") {
    const trigger =
      node.trigger.kind === "schedule"
        ? `schedule ${node.trigger.cron} (${node.trigger.tz})`
        : node.trigger.kind === "interval"
          ? `interval ${node.trigger.everyMs}ms`
          : node.trigger.kind === "http"
            ? `http (${renderAccess(node.trigger.access)})`
            : "enqueue";
    const concurrency = `${node.concurrency.mode} max=${node.concurrency.max} ${
      node.concurrency.keyed
        ? "keyed"
        : `unkeyed${node.concurrency.reason ? ` (${node.concurrency.reason})` : ""}`
    }`;
    return [
      `job ${node.id}`,
      `module: ${node.moduleId}`,
      `trigger: ${trigger}`,
      `concurrency: ${concurrency}`,
      `retry: ${node.retry.attempts} attempts, backoff ${node.retry.backoff.initialMs}ms`,
      `transaction: ${node.transaction}`,
      `effects: ${displayIds(node.effects)}`,
      `enqueues: ${displayIds(node.enqueues)}`,
      `triggers: ${displayIds(node.operations.triggers)}`,
      ...(node.retention
        ? [
            `retention: completed ${node.retention.completedMs}ms, dead-lettered ${node.retention.deadLetteredMs}ms`,
          ]
        : []),
    ].join("\n");
  }
  return [
    `operation ${node.id}`,
    `module: ${node.moduleId}`,
    `access: ${renderAccess(node.access)}`,
    `transaction: ${node.transaction}`,
    `transport: ${node.transport?.binding ?? node.transport?.kind ?? "none"}`,
    `dependencies: ${displayIds(node.dependencies.map((item) => item.providerId))}`,
    `errors: ${displayIds(node.errors.map((item) => item.code))}`,
    `cache: ${
      node.cache
        ? `${node.cache.scope} ttl=${node.cache.ttlMs}ms tags=${displayIds(node.cache.tags)}`
        : "none"
    }`,
    `invalidates: ${displayIds(
      (node.invalidates ?? []).map((tag) => {
        const scoped = (node.invalidatesScoped ?? []).find((item) => item.tag === tag);
        return scoped ? `${tag} (${scoped.scope})` : tag;
      }),
    )}`,
    ...(node.job
      ? [
          `job: ${node.job.map((item) => `${item.role}${item.jobId ? ` ${item.jobId}` : ""}${item.action ? ` ${item.action}` : ""}`).join(", ")}`,
        ]
      : []),
  ].join("\n");
}

function renderAccess(access) {
  return access.kind === "permissions"
    ? `${access.mode}(${access.permissions.join(", ")})`
    : access.kind === "provider"
      ? `provider(${access.provider})`
      : access.kind;
}

function renderFailure(error, format) {
  const payload = { command: "graph", ok: false, diagnostics: error.diagnostics };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return error.diagnostics
    .map((item) => {
      const subject = item.operationId ?? item.providerId ?? item.moduleId ?? item.path;
      return [
        `${item.code}${subject ? ` [${subject}]` : ""}: ${item.message}`,
        `  ${item.hint}`,
      ].join("\n");
    })
    .join("\n");
}

function displayIds(ids) {
  return ids.length > 0 ? ids.join(", ") : "(none)";
}

/**
 * Declaration-time errors (`InvalidJobDefinitionError`, `InvalidOperationDefinitionError`, ...)
 * throw while the app module loads; they carry a stable `SHIP_*` code and become
 * application diagnostics instead of opaque load failures.
 */
function definitionDiagnostic(cause) {
  if (
    !isObject(cause) ||
    typeof cause.code !== "string" ||
    !DEFINITION_ERROR_PATTERN.test(cause.code) ||
    cause.code.startsWith("SHIP_CLI_") ||
    typeof cause.message !== "string"
  ) {
    return undefined;
  }
  const subject = ["jobId", "operationId", "outboxId", "moduleId", "providerId"].find(
    (field) => typeof cause[field] === "string",
  );
  return {
    code: cause.code,
    severity: "error",
    message: cause.message,
    hint: "Fix the declaration named in the diagnostic; declaration errors are raised before the graph compiles.",
    ...(subject === "jobId" || subject === "operationId" ? { operationId: cause[subject] } : {}),
    ...(subject === "moduleId" ? { moduleId: cause.moduleId } : {}),
    ...(subject === "providerId" || subject === "outboxId" ? { providerId: cause[subject] } : {}),
    ...(typeof cause.field === "string" ? { path: cause.field } : {}),
  };
}

function normalizeGraphError(cause) {
  if (cause instanceof GraphCliError) return cause;
  if (hasApplicationDiagnostics(cause)) {
    return new GraphCliError(cause.diagnostics, GRAPH_CLI_EXIT.applicationInvalid, { cause });
  }
  if (
    isObject(cause) &&
    typeof cause.code === "string" &&
    cause.code.startsWith("SHIP_CONTRACT_") &&
    typeof cause.message === "string"
  ) {
    return new GraphCliError(
      [
        {
          code: cause.code,
          severity: "error",
          message: cause.message,
          hint: "Fix the operation schema or explicit contract metadata, then regenerate.",
          ...(typeof cause.operationId === "string" ? { operationId: cause.operationId } : {}),
          ...(typeof cause.path === "string" ? { path: cause.path } : {}),
        },
      ],
      GRAPH_CLI_EXIT.applicationInvalid,
      { cause },
    );
  }
  const definitionError = definitionDiagnostic(cause);
  if (definitionError) {
    return new GraphCliError([definitionError], GRAPH_CLI_EXIT.applicationInvalid, { cause });
  }
  return cliError(
    "SHIP_CLI_UNEXPECTED",
    `graph command failed unexpectedly: ${safeErrorMessage(cause)}`,
    "Re-run with the JSON format and report this diagnostic with the failing application module.",
    {},
    { cause },
  );
}

function cliError(code, message, hint, context = {}, options) {
  return new GraphCliError(
    [{ code, severity: "error", message, hint, ...context }],
    GRAPH_CLI_EXIT.usageOrLoadError,
    options,
  );
}

function hasApplicationDiagnostics(value) {
  return (
    isObject(value) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(
      (item) =>
        isObject(item) &&
        typeof item.code === "string" &&
        typeof item.message === "string" &&
        typeof item.hint === "string",
    )
  );
}

function safeErrorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function defaultIo() {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

export const __test = Object.freeze({
  affectedByModule,
  affectedByOperation,
  affectedByProvider,
  normalizeGraphError,
  projectPermissions,
  renderFailure,
  renderSuccess,
});
