import { CONTRACT_SCHEMA_METADATA_KEY, defineRichText } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import {
  RICH_TEXT_DOCUMENT_JSON_SCHEMA,
  richTextDocumentSchema,
  richTextIssuesSchema,
} from "./document-schema.js";

const field = defineRichText({ id: "templates.body" });
const valid = {
  schemaVersion: 1,
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

describe("richTextDocumentSchema", () => {
  it("validates the full allowlist when given a field", () => {
    const schema = richTextDocumentSchema(field);
    expect(schema["~standard"].validate(valid)).toEqual({ value: valid });
    expect(schema["~standard"].validate({ ...valid, content: [{ type: "script" }] })).toEqual({
      issues: [
        { message: 'node "script" is not allowed', path: ["content", 0, "type"] },
        { message: "doc requires block content at position 0", path: ["content"] },
      ],
    });
    expect(schema[CONTRACT_SCHEMA_METADATA_KEY]).toEqual({
      jsonSchema: RICH_TEXT_DOCUMENT_JSON_SCHEMA,
    });
  });

  it("checks only the envelope without a field", () => {
    const schema = richTextDocumentSchema();
    expect(schema["~standard"].validate({ ...valid, content: [{ type: "script" }] })).toEqual({
      value: { ...valid, content: [{ type: "script" }] },
    });
    for (const input of [
      null,
      "<p>",
      { type: "doc" },
      { ...valid, schemaVersion: 2 },
      { ...valid, content: {} },
    ]) {
      expect(schema["~standard"].validate(input)).toMatchObject({ issues: [{ path: [] }] });
    }
  });

  it("types the issues detail", () => {
    const schema = richTextIssuesSchema();
    const issues = [{ code: "SHIP_RICH_TEXT_NODE_UNKNOWN", message: "m", path: ["content", 0] }];
    expect(schema["~standard"].validate({ issues })).toEqual({ value: { issues } });
    expect(schema["~standard"].validate({ issues: [{ code: 1 }] })).toMatchObject({ issues: [{}] });
    expect(schema[CONTRACT_SCHEMA_METADATA_KEY].jsonSchema).toMatchObject({ required: ["issues"] });
  });
});
