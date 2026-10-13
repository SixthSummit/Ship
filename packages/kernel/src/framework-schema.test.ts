import { describe, expect, it } from "vitest";
import {
  arraySchema,
  integerSchema,
  jsonValueSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "./framework-schema.js";
import { isRuntimeSchema } from "./schema.js";

describe("framework schemas", () => {
  const schema = objectSchema({
    id: stringSchema({ minLength: 1 }),
    limit: optionalSchema(integerSchema({ minimum: 1, maximum: 10 })),
    tags: arraySchema(stringSchema()),
    payload: jsonValueSchema(),
  });

  it("validates nested values and freezes the result", () => {
    const result = schema["~standard"].validate({
      id: "a",
      tags: ["x"],
      payload: { any: true },
    });

    expect(result).toEqual({ value: { id: "a", tags: ["x"], payload: { any: true } } });
    expect(Object.isFrozen((result as { value: unknown }).value)).toBe(true);
    expect(isRuntimeSchema(schema)).toBe(true);
    expect(schema["~standard"].vendor).toBe("ship");
  });

  it.each([
    ["non-object", "nope", []],
    ["missing required", { tags: [], payload: null }, ["id"]],
    ["empty string", { id: "", tags: [], payload: null }, ["id"]],
    ["out-of-range integer", { id: "a", limit: 11, tags: [], payload: null }, ["limit"]],
    ["non-integer", { id: "a", limit: 1.5, tags: [], payload: null }, ["limit"]],
    ["non-array", { id: "a", tags: "x", payload: null }, ["tags"]],
    ["bad array item", { id: "a", tags: [1], payload: null }, ["tags", 0]],
  ])("reports %s with a path", (_name, value, path) => {
    const result = schema["~standard"].validate(value) as {
      issues?: readonly { path?: readonly unknown[] }[];
    };
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]?.path).toEqual(path);
  });

  it("projects a client-contract JSON Schema with required and optional fields", () => {
    expect(schema["~ship.contract"].jsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["id", "payload", "tags"],
      properties: {
        id: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
        payload: {},
        tags: { type: "array", items: { type: "string", minLength: 0 } },
      },
    });
    expect(Object.isFrozen(schema["~ship.contract"].jsonSchema)).toBe(true);
    expect(objectSchema({})["~ship.contract"].jsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });

  it("accepts omitted optional fields and rejects present invalid ones", () => {
    const optional = optionalSchema(integerSchema({ minimum: 0 }));
    expect(optional.optional).toBe(true);
    expect(optional["~standard"].validate(undefined)).toEqual({ value: undefined });
    expect(optional["~standard"].validate(-1)).toMatchObject({ issues: [expect.anything()] });
    expect(integerSchema({})["~standard"].validate(3)).toEqual({ value: 3 });
  });
});
