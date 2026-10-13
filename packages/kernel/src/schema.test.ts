import { describe, expect, it } from "vitest";
import { z } from "zod";
import { objectSchema, stringSchema } from "./framework-schema.js";
import {
  CONTRACT_SCHEMA_METADATA_KEY,
  hasContractProjection,
  isManifestProjectable,
  isRuntimeSchema,
  NATIVELY_PROJECTED_SCHEMA_VENDORS,
} from "./schema.js";

describe("isRuntimeSchema", () => {
  it("accepts Zod through the Standard Schema v1 contract", () => {
    expect(isRuntimeSchema(z.object({ id: z.string() }))).toBe(true);
  });

  it("accepts another structurally compatible Standard Schema", () => {
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "fixture",
        validate: (value: unknown) => ({ value }),
      },
    };

    expect(isRuntimeSchema(schema)).toBe(true);
  });

  it.each([
    undefined,
    {},
    { "~standard": null },
    { "~standard": { version: 2, vendor: "fixture", validate: () => ({}) } },
    { "~standard": { version: 1, vendor: "fixture" } },
  ])("rejects malformed schema %#", (schema) => {
    expect(isRuntimeSchema(schema)).toBe(false);
  });
});

describe("manifest projectability", () => {
  const opaque = {
    "~standard": {
      version: 1 as const,
      vendor: "fixture",
      validate: (value: unknown) => ({ value }),
    },
  };

  it("recognises declared contract metadata and natively projected vendors", () => {
    expect(CONTRACT_SCHEMA_METADATA_KEY).toBe("~ship.contract");
    expect(NATIVELY_PROJECTED_SCHEMA_VENDORS).toEqual(["zod"]);
    expect(hasContractProjection(objectSchema({ id: stringSchema() }))).toBe(true);
    expect(hasContractProjection(z.object({}))).toBe(false);
    expect(hasContractProjection(opaque)).toBe(false);
    expect(hasContractProjection({ ...opaque, "~ship.contract": { jsonSchema: null } })).toBe(
      false,
    );
    expect(hasContractProjection({ ...opaque, "~ship.contract": "yes" })).toBe(false);
    expect(hasContractProjection(null)).toBe(false);
    expect(
      hasContractProjection({ ...opaque, "~ship.contract": { jsonSchema: { type: "object" } } }),
    ).toBe(true);
    expect(isManifestProjectable(z.string())).toBe(true);
    expect(isManifestProjectable(objectSchema({}))).toBe(true);
    expect(isManifestProjectable(opaque)).toBe(false);
  });
});
