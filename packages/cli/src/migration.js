import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GRAPH_CLI_EXIT, GraphCliError, loadApplication } from "./graph.js";

const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

/**
 * Load an application, legacy route catalog, and disposition mapping from disk
 * and enforce the migration's exactly-once route accounting invariant.
 *
 * @param {{cwd?: string, appPath?: string, catalogPath: string, mappingPath: string}} options
 */
export async function checkRouteMigration(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const catalogPath = resolve(cwd, options.catalogPath);
  const mappingPath = resolve(cwd, options.mappingPath);
  const application = await loadApplication({ cwd, appPath: options.appPath });
  const catalog = await readJsonDocument(catalogPath, "catalog");
  const mapping = await readJsonDocument(mappingPath, "mapping");

  return validateRouteMigration(application, catalog, mapping, { catalogPath, mappingPath });
}

/**
 * Validate already-loaded migration data. This pure entrypoint is intended for
 * tests and for consumers that generate the catalog in memory.
 *
 * Catalog shape:
 * `{schemaVersion: 1, applicationId, revision, routes: [{id, method, path, source?}]}`
 *
 * Mapping shape:
 * `{schemaVersion: 1, applicationId, catalogRevision, entries: [{legacyRouteId,
 * operationId} | {legacyRouteId, removal: {decisionId, reason}}]}`
 *
 * @param {import("@sixthsummit/ship-core").CompiledApplication<string, readonly import("@sixthsummit/ship-core").AnyModule[]>} application
 * @param {unknown} catalogDocument
 * @param {unknown} mappingDocument
 * @param {{catalogPath?: string, mappingPath?: string}} [options]
 */
export function validateRouteMigration(
  application,
  catalogDocument,
  mappingDocument,
  options = {},
) {
  const diagnostics = [];
  const catalog = readCatalog(catalogDocument, diagnostics);
  const mapping = readMapping(mappingDocument, diagnostics);

  if (catalog && mapping) {
    validateDocumentIdentity(application.id, catalog, mapping, diagnostics);
    validateExactlyOnceMapping(application.graph, catalog, mapping, diagnostics);
  }

  if (diagnostics.length > 0) {
    throw new GraphCliError(sortDiagnostics(diagnostics), GRAPH_CLI_EXIT.applicationInvalid);
  }

  const mapped = mapping.entries.filter((entry) => entry.operationId !== undefined).length;
  const removed = mapping.entries.length - mapped;
  return Object.freeze({
    command: "migrate-routes",
    ok: true,
    appId: application.id,
    catalogRevision: catalog.revision,
    routes: catalog.routes.length,
    mapped,
    removed,
    catalog: options.catalogPath ?? "(memory)",
    mapping: options.mappingPath ?? "(memory)",
  });
}

function readCatalog(document, diagnostics) {
  if (!isObject(document)) {
    invalid(diagnostics, "SHIP_MIGRATION_CATALOG_INVALID", "catalog", "must be an object");
    return undefined;
  }
  if (document.schemaVersion !== 1) {
    invalid(diagnostics, "SHIP_MIGRATION_CATALOG_INVALID", "catalog.schemaVersion", "must equal 1");
  }
  const applicationId = readRequiredString(
    document.applicationId,
    "catalog.applicationId",
    "SHIP_MIGRATION_CATALOG_INVALID",
    diagnostics,
  );
  const revision = readRequiredString(
    document.revision,
    "catalog.revision",
    "SHIP_MIGRATION_CATALOG_INVALID",
    diagnostics,
  );
  if (!Array.isArray(document.routes)) {
    invalid(diagnostics, "SHIP_MIGRATION_CATALOG_INVALID", "catalog.routes", "must be an array");
    return undefined;
  }

  const routes = [];
  for (const [index, value] of document.routes.entries()) {
    const path = `catalog.routes[${index}]`;
    if (!isObject(value)) {
      invalid(diagnostics, "SHIP_MIGRATION_CATALOG_INVALID", path, "must be an object");
      continue;
    }
    const id = readRequiredString(
      value.id,
      `${path}.id`,
      "SHIP_MIGRATION_CATALOG_INVALID",
      diagnostics,
    );
    const method = readRequiredString(
      value.method,
      `${path}.method`,
      "SHIP_MIGRATION_CATALOG_INVALID",
      diagnostics,
    );
    const routePath = readRequiredString(
      value.path,
      `${path}.path`,
      "SHIP_MIGRATION_CATALOG_INVALID",
      diagnostics,
    );
    if (method && (!HTTP_METHODS.has(method) || method !== method.toUpperCase())) {
      invalid(
        diagnostics,
        "SHIP_MIGRATION_CATALOG_INVALID",
        `${path}.method`,
        "must be an uppercase supported HTTP method",
      );
    }
    if (routePath && (!routePath.startsWith("/") || /[?#]/u.test(routePath))) {
      invalid(
        diagnostics,
        "SHIP_MIGRATION_CATALOG_INVALID",
        `${path}.path`,
        "must be an absolute path without a query string or fragment",
      );
    }
    if (value.source !== undefined && !isNonEmptyString(value.source)) {
      invalid(
        diagnostics,
        "SHIP_MIGRATION_CATALOG_INVALID",
        `${path}.source`,
        "must be a non-empty string when present",
      );
    }
    if (id && method && HTTP_METHODS.has(method) && routePath?.startsWith("/")) {
      routes.push({ id, method, path: routePath, source: value.source });
    }
  }

  diagnoseDuplicates(
    routes,
    (route) => route.id,
    "SHIP_MIGRATION_LEGACY_ID_DUPLICATE",
    (key) => `legacy route id ${JSON.stringify(key)} occurs more than once`,
    "Give every source registration one stable unique id.",
    diagnostics,
  );
  diagnoseDuplicates(
    routes,
    (route) => `${route.method} ${route.path}`,
    "SHIP_MIGRATION_LEGACY_ROUTE_DUPLICATE",
    (key) => `legacy method/path ${JSON.stringify(key)} is registered more than once`,
    "Resolve the duplicate registration or record one approved catalog delta before mapping.",
    diagnostics,
  );

  return applicationId && revision ? { applicationId, revision, routes } : undefined;
}

function readMapping(document, diagnostics) {
  if (!isObject(document)) {
    invalid(diagnostics, "SHIP_MIGRATION_MAPPING_INVALID", "mapping", "must be an object");
    return undefined;
  }
  if (document.schemaVersion !== 1) {
    invalid(diagnostics, "SHIP_MIGRATION_MAPPING_INVALID", "mapping.schemaVersion", "must equal 1");
  }
  const applicationId = readRequiredString(
    document.applicationId,
    "mapping.applicationId",
    "SHIP_MIGRATION_MAPPING_INVALID",
    diagnostics,
  );
  const catalogRevision = readRequiredString(
    document.catalogRevision,
    "mapping.catalogRevision",
    "SHIP_MIGRATION_MAPPING_INVALID",
    diagnostics,
  );
  if (!Array.isArray(document.entries)) {
    invalid(diagnostics, "SHIP_MIGRATION_MAPPING_INVALID", "mapping.entries", "must be an array");
    return undefined;
  }

  const entries = [];
  for (const [index, value] of document.entries.entries()) {
    const path = `mapping.entries[${index}]`;
    if (!isObject(value)) {
      invalid(diagnostics, "SHIP_MIGRATION_MAPPING_INVALID", path, "must be an object");
      continue;
    }
    const legacyRouteId = readRequiredString(
      value.legacyRouteId,
      `${path}.legacyRouteId`,
      "SHIP_MIGRATION_MAPPING_INVALID",
      diagnostics,
    );
    const hasOperation = isNonEmptyString(value.operationId);
    const hasRemoval = isObject(value.removal);
    if (hasOperation === hasRemoval) {
      invalid(
        diagnostics,
        "SHIP_MIGRATION_MAPPING_INVALID",
        path,
        "must declare exactly one of operationId or removal",
      );
      continue;
    }
    if (!legacyRouteId) continue;
    if (hasOperation) {
      entries.push({ legacyRouteId, operationId: value.operationId });
      continue;
    }
    const decisionId = readRequiredString(
      value.removal.decisionId,
      `${path}.removal.decisionId`,
      "SHIP_MIGRATION_MAPPING_INVALID",
      diagnostics,
    );
    const reason = readRequiredString(
      value.removal.reason,
      `${path}.removal.reason`,
      "SHIP_MIGRATION_MAPPING_INVALID",
      diagnostics,
    );
    if (decisionId && reason) entries.push({ legacyRouteId, removal: { decisionId, reason } });
  }

  diagnoseDuplicates(
    entries,
    (entry) => entry.legacyRouteId,
    "SHIP_MIGRATION_DISPOSITION_DUPLICATE",
    (key) => `legacy route ${JSON.stringify(key)} has more than one disposition`,
    "Keep exactly one operation mapping or approved removal for each legacy route id.",
    diagnostics,
  );
  diagnoseDuplicates(
    entries.filter((entry) => entry.operationId !== undefined),
    (entry) => entry.operationId,
    "SHIP_MIGRATION_OPERATION_DUPLICATE",
    (key) => `target operation ${JSON.stringify(key)} receives more than one legacy route`,
    "Give every legacy method/path its own operation id or record an approved removal.",
    diagnostics,
  );

  return applicationId && catalogRevision ? { applicationId, catalogRevision, entries } : undefined;
}

function validateDocumentIdentity(applicationId, catalog, mapping, diagnostics) {
  for (const [path, actual] of [
    ["catalog.applicationId", catalog.applicationId],
    ["mapping.applicationId", mapping.applicationId],
  ]) {
    if (actual !== applicationId) {
      diagnostics.push({
        code: "SHIP_MIGRATION_APPLICATION_MISMATCH",
        severity: "error",
        message: `${path} ${JSON.stringify(actual)} does not match target app ${JSON.stringify(applicationId)}`,
        hint: "Generate the catalog and mapping for the application being checked.",
        path,
      });
    }
  }
  if (mapping.catalogRevision !== catalog.revision) {
    diagnostics.push({
      code: "SHIP_MIGRATION_CATALOG_REVISION_MISMATCH",
      severity: "error",
      message: `mapping revision ${JSON.stringify(mapping.catalogRevision)} does not match catalog revision ${JSON.stringify(catalog.revision)}`,
      hint: "Regenerate or explicitly review the mapping against the candidate-SHA catalog.",
      path: "mapping.catalogRevision",
    });
  }
}

function validateExactlyOnceMapping(graph, catalog, mapping, diagnostics) {
  const routesById = new Map(catalog.routes.map((route) => [route.id, route]));
  const entriesByLegacyId = new Map();
  for (const entry of mapping.entries) {
    const entries = entriesByLegacyId.get(entry.legacyRouteId) ?? [];
    entries.push(entry);
    entriesByLegacyId.set(entry.legacyRouteId, entries);
  }

  for (const route of catalog.routes) {
    if (!entriesByLegacyId.has(route.id)) {
      diagnostics.push({
        code: "SHIP_MIGRATION_DISPOSITION_MISSING",
        severity: "error",
        message: `legacy route ${JSON.stringify(route.id)} (${route.method} ${route.path}) has no disposition`,
        hint: "Map it to one operation id or record an approved removal.",
        path: route.id,
      });
    }
  }

  const operationsById = new Map(graph.operations.map((operation) => [operation.id, operation]));
  for (const entry of mapping.entries) {
    const route = routesById.get(entry.legacyRouteId);
    if (!route) {
      diagnostics.push({
        code: "SHIP_MIGRATION_LEGACY_UNKNOWN",
        severity: "error",
        message: `mapping references unknown legacy route ${JSON.stringify(entry.legacyRouteId)}`,
        hint: "Use an id from the current candidate-SHA route catalog.",
        path: entry.legacyRouteId,
      });
      continue;
    }
    if (entry.operationId === undefined) continue;
    const operation = operationsById.get(entry.operationId);
    if (!operation) {
      diagnostics.push({
        code: "SHIP_MIGRATION_OPERATION_NOT_FOUND",
        severity: "error",
        message: `target operation ${JSON.stringify(entry.operationId)} does not exist`,
        hint: "Use an operation id from the compiled target application graph.",
        operationId: entry.operationId,
      });
      continue;
    }
    if (
      operation.transport?.kind !== "http" ||
      typeof operation.transport.metadata?.method !== "string" ||
      typeof operation.transport.metadata?.path !== "string"
    ) {
      diagnostics.push({
        code: "SHIP_MIGRATION_OPERATION_NOT_HTTP",
        severity: "error",
        message: `target operation ${JSON.stringify(entry.operationId)} has no concrete HTTP method/path`,
        hint: "Map legacy HTTP routes only to operations with an http transport declaration.",
        operationId: entry.operationId,
      });
      continue;
    }
    if (operation.transport.metadata.method !== route.method) {
      diagnostics.push({
        code: "SHIP_MIGRATION_METHOD_MISMATCH",
        severity: "error",
        message: `${entry.operationId} uses ${operation.transport.metadata.method}; legacy route ${entry.legacyRouteId} uses ${route.method}`,
        hint: "Preserve the method or record an approved removal and replacement contract.",
        operationId: entry.operationId,
      });
    }
    if (operation.transport.metadata.path !== route.path) {
      diagnostics.push({
        code: "SHIP_MIGRATION_PATH_MISMATCH",
        severity: "error",
        message: `${entry.operationId} uses ${operation.transport.metadata.path}; legacy route ${entry.legacyRouteId} uses ${route.path}`,
        hint: "Preserve the exact public path or record an approved removal and replacement contract.",
        operationId: entry.operationId,
      });
    }
  }
}

async function readJsonDocument(path, kind) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    throw documentError(
      "SHIP_MIGRATION_DOCUMENT_READ_FAILED",
      `${kind} document could not be read at ${JSON.stringify(path)}`,
      "Pass a readable JSON document generated for the current migration candidate.",
      path,
      cause,
    );
  }
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw documentError(
      "SHIP_MIGRATION_DOCUMENT_JSON_INVALID",
      `${kind} document at ${JSON.stringify(path)} is not valid JSON`,
      "Regenerate the document; do not hand-repair a partial artifact.",
      path,
      cause,
    );
  }
}

function readRequiredString(value, path, code, diagnostics) {
  if (isNonEmptyString(value)) return value;
  invalid(diagnostics, code, path, "must be a non-empty string");
  return undefined;
}

function diagnoseDuplicates(items, keyOf, code, message, hint, diagnostics) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) {
      diagnostics.push({ code, severity: "error", message: message(key), hint, path: key });
    }
  }
}

function invalid(diagnostics, code, path, requirement) {
  diagnostics.push({
    code,
    severity: "error",
    message: `${path} ${requirement}`,
    hint: "Use the documented schemaVersion 1 migration document shape.",
    path,
  });
}

function documentError(code, message, hint, path, cause) {
  return new GraphCliError(
    [{ code, severity: "error", message, hint, path }],
    GRAPH_CLI_EXIT.usageOrLoadError,
    { cause },
  );
}

function sortDiagnostics(diagnostics) {
  return diagnostics.sort((left, right) =>
    [left.code, left.path ?? "", left.operationId ?? "", left.message]
      .join("\0")
      .localeCompare(
        [right.code, right.path ?? "", right.operationId ?? "", right.message].join("\0"),
      ),
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
