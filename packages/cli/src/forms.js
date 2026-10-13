import { compileFunction } from "node:vm";

/**
 * Emit primitive identity-codec bindings from the projected body, never server validators.
 * @param {import("@sixthsummit/ship-contract").ClientContract} contract
 * @param {string} operationId
 * @param {Readonly<Record<string, string | number | boolean | null>>} initialValues
 * @param {string} [exportName]
 * @returns {string}
 */
export function renderOperationFormBinding(
  contract,
  operationId,
  initialValues,
  exportName = "operationFormBinding",
) {
  if (!/^[A-Za-z_$][\w$]*$/u.test(exportName)) throw new TypeError("Invalid form export name");
  try {
    if (exportName === "await") throw new SyntaxError("Module keyword");
    compileFunction(`"use strict"; const ${exportName} = null;`);
  } catch {
    throw new TypeError("Invalid form export name");
  }
  const operation = contract.operations.find((entry) => entry.id === operationId);
  const schema = operation?.input.body?.jsonSchema;
  if (!schema || schema.type !== "object" || !schema.properties)
    throw new TypeError("Form projection requires an object body");
  const composition = [
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "$ref",
    "$dynamicRef",
    "dependentSchemas",
    "dependentRequired",
  ];
  if (composition.some((key) => Object.hasOwn(schema, key)))
    throw new TypeError("Unsupported composed form body");
  const fields = Object.entries(schema.properties).map(([name, property]) => {
    if (property.anyOf && Object.hasOwn(property, "type"))
      throw new TypeError(`Unsupported intersected form field: ${name}`);
    if (composition.some((key) => key !== "anyOf" && Object.hasOwn(property, key)))
      throw new TypeError(`Unsupported form field: ${name}`);
    const nullBranch = property.anyOf?.find((entry) => entry.type === "null");
    if (
      nullBranch &&
      Object.keys(nullBranch).some((key) => !["type", "title", "description"].includes(key))
    )
      throw new TypeError(`Unsupported null form branch: ${name}`);
    if (["__proto__", "constructor", "prototype"].includes(name))
      throw new TypeError(`Unsupported form field name: ${name}`);
    if (
      property.enum ||
      property.const !== undefined ||
      property.allOf ||
      property.oneOf ||
      (property.anyOf &&
        (property.anyOf.length !== 2 || !property.anyOf.some((entry) => entry.type === "null"))) ||
      (Array.isArray(property.type) &&
        (property.type.length !== 2 || !property.type.includes("null")))
    )
      throw new TypeError(`Unsupported form field: ${name}`);
    const nullable =
      property.anyOf?.find((entry) => entry.type === "null") ||
      (Array.isArray(property.type) && property.type.includes("null"));
    const valueSchema = property.anyOf
      ? property.anyOf.find((entry) => entry.type !== "null")
      : Array.isArray(property.type)
        ? { ...property, type: property.type.find((type) => type !== "null") }
        : property;
    if (!valueSchema || !["string", "number", "integer", "boolean"].includes(valueSchema.type))
      throw new TypeError(`Unsupported form field: ${name}`);
    if (valueSchema.enum || valueSchema.const !== undefined)
      throw new TypeError(`Unsupported form field: ${name}`);
    if (composition.some((key) => Object.hasOwn(valueSchema, key)))
      throw new TypeError(`Unsupported form field: ${name}`);
    if (!Object.hasOwn(initialValues, name))
      throw new TypeError(`Explicit initial value required: ${name}`);
    const initial = initialValues[name];
    const type = valueSchema.type === "integer" ? "number" : valueSchema.type;
    if (
      typeof initial === "number" &&
      (!Number.isFinite(initial) || (valueSchema.type === "integer" && !Number.isInteger(initial)))
    )
      throw new TypeError(`Invalid numeric initial value: ${name}`);
    if (!(initial === null && nullable) && typeof initial !== type)
      throw new TypeError(`Invalid initial value: ${name}`);
    const tsType = `${type}${nullable ? " | null" : ""}`;
    const optional = !(schema.required ?? []).includes(name);
    const state = optional
      ? { kind: "omitted", controlValue: initial }
      : { kind: "value", value: initial };
    const checks = [];
    if (type === "string" && valueSchema.minLength !== undefined)
      checks.push(
        `if (value !== null && value.length < ${Number(valueSchema.minLength)}) return [{path:[${JSON.stringify(name)}],code:"min_length",message:"Value is too short"}];`,
      );
    return `${JSON.stringify(name)}: { optional: ${optional}, initial: ${JSON.stringify(state)}, codec: { encode: (value: ${tsType}): ${tsType} => value, decode: (value: ${tsType}): ${tsType} => value }, validate: (value: ${tsType}) => { ${checks.join(" ")} return []; } }`;
  });
  if (Object.keys(initialValues).some((name) => !(name in schema.properties)))
    throw new TypeError("Unknown initial field");
  return `export const ${exportName} = { operation: ${JSON.stringify(operationId)}, fields: {${fields.join(",\n")}} } as const;\n`;
}
