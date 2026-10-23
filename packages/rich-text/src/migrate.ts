import type { RichTextDocument, RichTextMigration } from "@sixthsummit/ship-core";
import { RICH_TEXT_SCHEMA_VERSION } from "@sixthsummit/ship-core";
import { RichTextCapabilityError } from "./errors.js";

export interface MigrateRichTextDocumentOptions {
  readonly fieldId: string;
  readonly migrations: readonly RichTextMigration[];
  /** Defaults to the kernel's current schema version. */
  readonly to?: number;
}

/**
 * Applies the declared migrations one version at a time until the document
 * is at `to`. A document already there comes back unchanged; one with no
 * migration path, or from a newer schema than this kernel knows, is refused.
 * This is the explicit hook a release step calls when it rewrites stored
 * rows after a schema bump; rendering never migrates on its own.
 */
export function migrateRichTextDocument(
  input: unknown,
  options: MigrateRichTextDocumentOptions,
): RichTextDocument {
  const to = options.to ?? RICH_TEXT_SCHEMA_VERSION;
  const version =
    typeof input === "object" && input !== null ? Reflect.get(input, "schemaVersion") : undefined;
  if (!Number.isSafeInteger(version) || Reflect.get(input as object, "type") !== "doc") {
    throw new RichTextCapabilityError(
      "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED",
      `document of field ${JSON.stringify(options.fieldId)} carries no schema version`,
      { fieldId: options.fieldId },
    );
  }
  let document = input as RichTextDocument;
  let current = version as number;
  if (current > to) {
    throw new RichTextCapabilityError(
      "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED",
      `document of field ${JSON.stringify(options.fieldId)} is at schema version ${current}, newer than ${to}`,
      { fieldId: options.fieldId },
    );
  }
  while (current < to) {
    const step = options.migrations.find((migration) => migration.from === current);
    if (!step) {
      throw new RichTextCapabilityError(
        "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED",
        `field ${JSON.stringify(options.fieldId)} declares no migration from schema version ${current}`,
        { fieldId: options.fieldId },
      );
    }
    const migrated = step.migrate(document);
    document = { ...migrated, schemaVersion: step.to, type: "doc" };
    current = step.to;
  }
  return document;
}
