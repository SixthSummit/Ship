import { defineApp, defineModule, defineOperation, publicAccess } from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphCliError } from "./graph.js";
import { validateRouteMigration } from "./migration.js";

const body = z.object({ ok: z.literal(true) });

function operation(id, transport) {
  return defineOperation({
    id,
    ...(transport ? { transport } : {}),
    input: {},
    output: { 200: body },
    successStatus: 200,
    errors: [],
    access: publicAccess(),
    transaction: "none",
    dependencies: {},
    handler: () => ({ ok: true }),
  });
}

const application = defineApp({
  id: "migration-fixture",
  modules: [
    defineModule({
      id: "fixtures",
      operations: [
        operation("fixtures.read", http.get("/v1/fixtures/:id")),
        operation("fixtures.write", http.post("/v1/fixtures")),
        operation("fixtures.job"),
      ],
      providers: [],
      imports: [],
      exports: [],
    }),
  ],
});

function catalog(routes) {
  return {
    schemaVersion: 1,
    applicationId: "migration-fixture",
    revision: "candidate-a",
    routes,
  };
}

function mapping(entries) {
  return {
    schemaVersion: 1,
    applicationId: "migration-fixture",
    catalogRevision: "candidate-a",
    entries,
  };
}

const readRoute = {
  id: "fixtures.routes.ts:10:GET:/v1/fixtures/:id",
  method: "GET",
  path: "/v1/fixtures/:id",
  source: "src/fixtures/routes.ts:10",
};
const writeRoute = {
  id: "fixtures.routes.ts:20:POST:/v1/fixtures",
  method: "POST",
  path: "/v1/fixtures",
  source: "src/fixtures/routes.ts:20",
};

describe("legacy route migration accounting", () => {
  it("accepts one exact operation or approved removal per legacy route", () => {
    const result = validateRouteMigration(
      application,
      catalog([readRoute, writeRoute]),
      mapping([
        { legacyRouteId: readRoute.id, operationId: "fixtures.read" },
        {
          legacyRouteId: writeRoute.id,
          removal: { decisionId: "DEC-42", reason: "replaced by an asynchronous import" },
        },
      ]),
    );

    expect(result).toEqual({
      command: "migrate-routes",
      ok: true,
      appId: "migration-fixture",
      catalogRevision: "candidate-a",
      routes: 2,
      mapped: 1,
      removed: 1,
      catalog: "(memory)",
      mapping: "(memory)",
    });
  });

  it("aggregates duplicate, missing, and unknown route dispositions", () => {
    expect(() =>
      validateRouteMigration(
        application,
        catalog([readRoute, writeRoute]),
        mapping([
          { legacyRouteId: readRoute.id, operationId: "fixtures.read" },
          { legacyRouteId: readRoute.id, operationId: "fixtures.write" },
          { legacyRouteId: "legacy.unknown", operationId: "fixtures.read" },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "SHIP_MIGRATION_DISPOSITION_DUPLICATE" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_DISPOSITION_MISSING" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_LEGACY_UNKNOWN" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_OPERATION_DUPLICATE" }),
        ]),
      }),
    );
  });

  it("rejects missing, non-HTTP, and wire-incompatible target operations", () => {
    const routes = [
      { ...readRoute, method: "POST", path: "/v1/renamed/:id" },
      { ...writeRoute, id: "legacy.missing" },
      { ...writeRoute, id: "legacy.job" },
    ];

    expect(() =>
      validateRouteMigration(
        application,
        catalog(routes),
        mapping([
          { legacyRouteId: readRoute.id, operationId: "fixtures.read" },
          { legacyRouteId: "legacy.missing", operationId: "fixtures.missing" },
          { legacyRouteId: "legacy.job", operationId: "fixtures.job" },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "SHIP_MIGRATION_METHOD_MISMATCH" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_PATH_MISMATCH" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_OPERATION_NOT_FOUND" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_OPERATION_NOT_HTTP" }),
        ]),
      }),
    );
  });

  it("rejects stale identity, duplicate legacy bindings, and unapproved removals", () => {
    const invalidMapping = mapping([
      { legacyRouteId: readRoute.id, removal: { decisionId: "", reason: "no longer used" } },
    ]);
    invalidMapping.applicationId = "other-app";
    invalidMapping.catalogRevision = "candidate-old";

    expect(() =>
      validateRouteMigration(
        application,
        catalog([readRoute, { ...readRoute, id: "duplicate-binding" }]),
        invalidMapping,
      ),
    ).toThrowError(
      expect.objectContaining({
        exitCode: 1,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "SHIP_MIGRATION_APPLICATION_MISMATCH" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_CATALOG_REVISION_MISMATCH" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_LEGACY_ROUTE_DUPLICATE" }),
          expect.objectContaining({ code: "SHIP_MIGRATION_MAPPING_INVALID" }),
        ]),
      }),
    );
  });

  it("rejects malformed root documents with stable migration diagnostics", () => {
    for (const [badCatalog, badMapping, code] of [
      [null, mapping([]), "SHIP_MIGRATION_CATALOG_INVALID"],
      [catalog([]), null, "SHIP_MIGRATION_MAPPING_INVALID"],
    ]) {
      expect(() => validateRouteMigration(application, badCatalog, badMapping)).toThrowError(
        expect.objectContaining({
          name: GraphCliError.name,
          diagnostics: [expect.objectContaining({ code })],
        }),
      );
    }
  });
});
