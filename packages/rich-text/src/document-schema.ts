import {
  type AnyRichText,
  CONTRACT_SCHEMA_METADATA_KEY,
  type FrameworkFieldSchema,
  RICH_TEXT_SCHEMA_VERSION,
  type RichTextDocument,
  type RichTextIssue,
  type SchemaResult,
} from "@sixthsummit/ship-core";
import { compileRichTextSchema } from "./schema.js";
import { validateRichTextDocument } from "./validate.js";

const nodeJsonSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string" },
    attrs: { type: "object" },
    marks: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        properties: { type: { type: "string" }, attrs: { type: "object" } },
      },
    },
    content: { type: "array", items: { type: "object" } },
    text: { type: "string" },
  },
} as const;

/**
 * The JSON Schema a rich text document projects as in client contracts and
 * OpenAPI. Node nesting is left open on purpose: the allowlist is enforced
 * by the kernel-owned validator, not by JSON Schema, and the editor reads
 * the schema version and extension specs from the manifest's `richText` map.
 */
export const RICH_TEXT_DOCUMENT_JSON_SCHEMA = Object.freeze({
  type: "object",
  required: ["schemaVersion", "type", "content"],
  properties: {
    schemaVersion: { type: "integer", minimum: 1 },
    type: { type: "string", const: "doc" },
    content: { type: "array", items: nodeJsonSchema },
  },
  additionalProperties: false,
} as const);

export const RICH_TEXT_ISSUE_JSON_SCHEMA = Object.freeze({
  type: "object",
  required: ["code", "message", "path"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    path: { type: "array", items: { type: ["string", "integer"] } },
  },
} as const);

function frameworkSchema<TValue>(
  validate: (value: unknown) => SchemaResult<TValue>,
  jsonSchema: Readonly<Record<string, unknown>>,
): FrameworkFieldSchema<TValue> {
  return Object.freeze({
    "~standard": Object.freeze({ version: 1 as const, vendor: "ship", validate }),
    [CONTRACT_SCHEMA_METADATA_KEY]: Object.freeze({ jsonSchema }),
  }) as FrameworkFieldSchema<TValue>;
}

/**
 * A Standard Schema for an operation input that carries a rich text
 * document. With a field, the input is validated against that field's full
 * allowlist at the input boundary, so a refused document is a validation
 * failure with the issues as the path-addressed detail; without one, only
 * the document envelope is checked and `save` performs the full validation.
 */
export function richTextDocumentSchema(
  field?: AnyRichText,
): FrameworkFieldSchema<RichTextDocument> {
  const compiled = field ? compileRichTextSchema(field) : undefined;
  return frameworkSchema<RichTextDocument>((value) => {
    if (compiled) {
      const result = validateRichTextDocument(compiled, value);
      if (result.ok) return { value: result.document };
      return {
        issues: result.issues.map((issue) => ({ message: issue.message, path: [...issue.path] })),
      };
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Reflect.get(value, "type") !== "doc" ||
      !Number.isSafeInteger(Reflect.get(value, "schemaVersion")) ||
      (Reflect.get(value, "schemaVersion") as number) < 1 ||
      (Reflect.get(value, "schemaVersion") as number) > RICH_TEXT_SCHEMA_VERSION ||
      !Array.isArray(Reflect.get(value, "content"))
    ) {
      return {
        issues: [
          {
            message: `expected a rich text document at schema version ${RICH_TEXT_SCHEMA_VERSION}`,
            path: [],
          },
        ],
      };
    }
    return { value: value as RichTextDocument };
  }, RICH_TEXT_DOCUMENT_JSON_SCHEMA);
}

/** The details schema for a declared error that reports refused documents (`{ issues }`). */
export function richTextIssuesSchema(): FrameworkFieldSchema<{
  readonly issues: readonly RichTextIssue[];
}> {
  return frameworkSchema<{ readonly issues: readonly RichTextIssue[] }>(
    (value) => {
      const issues =
        typeof value === "object" && value !== null ? Reflect.get(value, "issues") : undefined;
      if (
        !Array.isArray(issues) ||
        !issues.every(
          (issue) =>
            typeof issue === "object" &&
            issue !== null &&
            typeof Reflect.get(issue, "code") === "string" &&
            typeof Reflect.get(issue, "message") === "string" &&
            Array.isArray(Reflect.get(issue, "path")),
        )
      ) {
        return { issues: [{ message: "expected { issues: RichTextIssue[] }", path: [] }] };
      }
      return { value: { issues: issues as RichTextIssue[] } };
    },
    {
      type: "object",
      required: ["issues"],
      properties: { issues: { type: "array", items: RICH_TEXT_ISSUE_JSON_SCHEMA } },
    },
  );
}
