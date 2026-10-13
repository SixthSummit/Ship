import ts from "typescript";
import { describe, expect, it } from "vitest";
import { renderOperationFormBinding } from "./forms.js";

const contract = {
  operations: [
    {
      id: "accounts.create",
      input: {
        body: {
          jsonSchema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", minLength: 1 },
              note: { type: ["string", "null"] },
              enabled: { type: "boolean" },
            },
          },
        },
      },
    },
  ],
};
describe("primitive form projection", () => {
  it("parses binding identifiers rather than maintaining an incomplete keyword list", () => {
    for (const name of [
      "extends",
      "await",
      "arguments",
      "class",
      "false",
      "enum",
      "implements",
      "yield",
      "a;throw",
    ])
      expect(() => renderOperationFormBinding(contract, "accounts.create", {}, name)).toThrow(
        "export name",
      );
    const source = renderOperationFormBinding(
      contract,
      "accounts.create",
      { name: "", note: null, enabled: false },
      "validBinding",
    );
    expect(
      ts.transpileModule(source, {
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      }).diagnostics,
    ).toEqual([]);
  });
  it("rejects composed root and nullable branch requirements", () => {
    expect(() =>
      one({ type: "string", anyOf: [{ type: "string" }, { type: "null" }] }, null),
    ).toThrow("intersected form field");
    expect(() =>
      one({ anyOf: [{ type: "string" }, { type: "null" }], not: { type: "null" } }, null),
    ).toThrow("Unsupported form field");
    expect(() =>
      one({ anyOf: [{ type: "string" }, { type: "null", not: { type: "null" } }] }, null),
    ).toThrow("Unsupported null form branch");
    const source = structuredClone(contract);
    source.operations[0].input.body.jsonSchema.allOf = [{ required: ["note"] }];
    expect(() =>
      renderOperationFormBinding(source, "accounts.create", {
        name: "",
        note: null,
        enabled: false,
      }),
    ).toThrow("composed form body");
    expect(() =>
      one({ anyOf: [{ type: "string", allOf: [{ const: "x" }] }, { type: "null" }] }, null),
    ).toThrow("Unsupported form field");
  });
  function one(property, initial = 0, name = "value") {
    return renderOperationFormBinding(
      {
        operations: [
          {
            id: "a.b",
            input: { body: { jsonSchema: { type: "object", properties: { [name]: property } } } },
          },
        ],
      },
      "a.b",
      { [name]: initial },
    );
  }
  it("supports numeric identity and either nullable schema syntax", () => {
    expect(one({ type: "number" }, 1.25)).toContain("value: number");
    expect(one({ type: "integer" }, 0)).toContain("value: number");
    expect(one({ anyOf: [{ type: "string" }, { type: "null" }] }, null)).toContain("string | null");
    expect(() => one({ type: "integer" }, 0.1)).toThrow("numeric initial");
    expect(() => one({ type: "number" }, Infinity)).toThrow("numeric initial");
  });
  it("rejects ambiguous unions, narrowed primitive schemas and unsafe names", () => {
    for (const property of [
      { enum: ["a"], type: "string" },
      { const: "a", type: "string" },
      { allOf: [{ type: "string" }] },
      { oneOf: [{ type: "string" }] },
      { anyOf: [{ type: "number" }, { type: "boolean" }] },
      { type: ["number", "boolean"] },
      { anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }] },
    ])
      expect(() => one(property)).toThrow("Unsupported form field");
    expect(() => one({ type: "string" }, "", "__proto__")).toThrow("field name");
    expect(() =>
      renderOperationFormBinding(contract, "accounts.create", {
        name: "",
        note: null,
        enabled: false,
        extra: 1,
      }),
    ).toThrow("Unknown initial field");
    expect(() => renderOperationFormBinding(contract, "accounts.create", {}, "class")).toThrow(
      "export name",
    );
  });
  it("retains explicit omitted versus nullable and false control state", () => {
    const result = renderOperationFormBinding(contract, "accounts.create", {
      name: "",
      note: null,
      enabled: false,
    });
    expect(result).toContain('"kind":"omitted","controlValue":null');
    expect(result).toContain('"kind":"omitted","controlValue":false');
    expect(result).toContain('"kind":"value","value":""');
    expect(result).toContain("string | null");
    expect(result).toContain('code:"min_length"');
    expect(result).not.toContain("import ");
  });
  it("requires explicit initial values and rejects incompatible declarations", () => {
    expect(() => renderOperationFormBinding(contract, "accounts.create", { name: "" })).toThrow(
      "Explicit initial value",
    );
    expect(() =>
      renderOperationFormBinding(contract, "accounts.create", {
        name: 1,
        note: null,
        enabled: false,
      }),
    ).toThrow("Invalid initial value");
    expect(() => renderOperationFormBinding(contract, "missing", {})).toThrow("object body");
    expect(() => renderOperationFormBinding(contract, "accounts.create", {}, "x;eval")).toThrow(
      "export name",
    );
  });
  it("does not guess nested or collection codecs", () => {
    const nested = {
      operations: [
        {
          id: "a.b",
          input: {
            body: {
              jsonSchema: {
                type: "object",
                properties: { items: { type: "array", items: { type: "string" } } },
              },
            },
          },
        },
      ],
    };
    expect(() => renderOperationFormBinding(nested, "a.b", { items: [] })).toThrow(
      "Unsupported form field",
    );
  });
});
