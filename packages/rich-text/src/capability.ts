import {
  type AnyRichText,
  defineProvider,
  type Provider,
  type RichTextCapability,
  type RichTextDependencyToken,
  type RichTextDocument,
  type RichTextIssue,
  type RichTextRenderOptions,
  type RichTextSaved,
  type ScopedAttachmentCapability,
  type ScopedRichTextCapability,
} from "@sixthsummit/ship-core";
import { RichTextCapabilityError } from "./errors.js";
import { migrateRichTextDocument } from "./migrate.js";
import {
  collectRichTextAttachments,
  type RichTextAttachmentRendering,
  renderRichTextHtml,
  renderRichTextText,
} from "./render.js";
import { type CompiledRichTextSchema, compileRichTextSchema } from "./schema.js";
import { sanitizeRichTextDocument, validateRichTextDocument } from "./validate.js";

export interface RichTextCapabilityOptions {
  /** A precompiled schema, for tests that inspect it; defaults to compiling the field. */
  readonly schema?: CompiledRichTextSchema;
}

/**
 * Builds the capability bound to `field.binding`. The executor calls
 * `withScope` once per run with the unit-of-work scope and, when the field
 * embeds an attachment, that attachment's capability scoped the same way;
 * `save` and `clear` reconcile embedded objects through it so the ledger
 * change and the purge intents commit with the owning record (ADR-0022).
 */
export function createRichTextCapability(
  field: AnyRichText,
  options: RichTextCapabilityOptions = {},
): RichTextCapability {
  const schema = options.schema ?? compileRichTextSchema(field);
  const fieldId = field.id;

  const invalid = (issues: readonly RichTextIssue[]): RichTextCapabilityError =>
    new RichTextCapabilityError(
      "SHIP_RICH_TEXT_INVALID",
      `document of field ${JSON.stringify(fieldId)} is not allowed: ${issues
        .slice(0, 3)
        .map((issue) => `${issue.code} at ${issue.path.join(".") || "$"}`)
        .join("; ")}`,
      { fieldId, issues },
    );

  /** Envelope problems no sanitizer can repair; `onInvalid: "sanitize"` still refuses them. */
  const unrepairable = new Set<RichTextIssue["code"]>([
    "SHIP_RICH_TEXT_DOCUMENT_INVALID",
    "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED",
    "SHIP_RICH_TEXT_TOO_LARGE",
  ]);

  const check = (input: unknown, reject?: (objectId: string) => boolean): RichTextDocument => {
    if (field.onInvalid === "sanitize") {
      const sanitized = sanitizeRichTextDocument(schema, input, {
        ...(reject ? { rejectAttachment: reject } : {}),
      });
      const fatal = sanitized.dropped.filter((issue) => unrepairable.has(issue.code));
      if (fatal.length > 0) throw invalid(fatal);
      return sanitized.document;
    }
    const validated = validateRichTextDocument(schema, input, {
      ...(reject ? { rejectAttachment: reject } : {}),
    });
    if (!validated.ok) throw invalid(validated.issues);
    return validated.document;
  };

  const withScope = (
    scope: object | undefined,
    attachments: ScopedAttachmentCapability | undefined,
  ): ScopedRichTextCapability => {
    const requireAttachments = (action: string): ScopedAttachmentCapability => {
      if (!attachments) {
        throw new RichTextCapabilityError(
          "SHIP_RICH_TEXT_ATTACHMENTS_UNCONFIGURED",
          `${action} on field ${JSON.stringify(fieldId)} needs its attachment capability; the field declares none or the storage module is not mounted`,
          { fieldId },
        );
      }
      return attachments;
    };

    const resolveAttachments = async (
      document: RichTextDocument,
      renderOptions: RichTextRenderOptions,
    ): Promise<ReadonlyMap<string, RichTextAttachmentRendering | undefined>> => {
      const ids = collectRichTextAttachments(document);
      const resolved = new Map<string, RichTextAttachmentRendering | undefined>();
      if (ids.length === 0) return resolved;
      const capability = requireAttachments("render");
      await Promise.all(
        ids.map(async (objectId) => {
          const [object, url] = await Promise.all([
            capability.read(objectId),
            capability.url(objectId, {
              ...(renderOptions.expiresInMs !== undefined
                ? { expiresInMs: renderOptions.expiresInMs }
                : {}),
            }),
          ]);
          resolved.set(
            objectId,
            url && object
              ? Object.freeze({ url: url.url, contentType: object.contentType })
              : undefined,
          );
        }),
      );
      return resolved;
    };

    const scoped: ScopedRichTextCapability = {
      fieldId,
      schemaVersion: schema.version,
      validate: (input) => validateRichTextDocument(schema, input),
      sanitize: (input) => sanitizeRichTextDocument(schema, input),
      text: (document) => renderRichTextText(schema, document),
      attachments: (document) => collectRichTextAttachments(document),
      render: async (input, renderOptions = {}) => {
        const validated = validateRichTextDocument(schema, input);
        if (!validated.ok) throw invalid(validated.issues);
        return renderRichTextHtml(schema, validated.document, {
          attachments: await resolveAttachments(validated.document, renderOptions),
        });
      },
      save: async ({ ownerId, document: input }): Promise<RichTextSaved> => {
        let document = check(input);
        let ids = collectRichTextAttachments(document);
        let existing = new Set<string>();
        if (ids.length > 0 || schema.attachments) {
          if (ids.length > 0 || attachments) {
            const capability = ids.length > 0 ? requireAttachments("save") : attachments;
            if (capability) {
              existing = new Set((await capability.list(ownerId)).map((object) => object.id));
            }
          }
        }
        if (ids.length > 0) {
          const capability = requireAttachments("save");
          const unavailable = new Set<string>();
          await Promise.all(
            ids
              .filter((objectId) => !existing.has(objectId))
              .map(async (objectId) => {
                const object = await capability.read(objectId);
                if (!object || object.status !== "uploaded") unavailable.add(objectId);
              }),
          );
          if (unavailable.size > 0) {
            document = check(input, (objectId) => unavailable.has(objectId));
            ids = collectRichTextAttachments(document);
          }
        }
        const toAttach = ids.filter((objectId) => !existing.has(objectId));
        const toDetach = [...existing].filter((objectId) => !ids.includes(objectId));
        if ((toAttach.length > 0 || toDetach.length > 0) && scope === undefined) {
          throw new RichTextCapabilityError(
            "SHIP_RICH_TEXT_SCOPE_REQUIRED",
            `save on field ${JSON.stringify(fieldId)} changes embedded objects and requires a transaction: "write" operation so the attachments commit with the owning record`,
            { fieldId },
          );
        }
        if (toAttach.length > 0 || toDetach.length > 0) {
          const capability = requireAttachments("save");
          for (const objectId of toAttach) await capability.attach({ ownerId, objectId });
          for (const objectId of toDetach) await capability.detach({ ownerId, objectId });
        }
        return Object.freeze({
          document,
          text: renderRichTextText(schema, document),
          attachmentIds: ids,
          attached: Object.freeze(toAttach),
          detached: Object.freeze(toDetach),
        });
      },
      clear: async ({ ownerId }) => {
        if (!attachments) return Object.freeze([]);
        if (scope === undefined) {
          throw new RichTextCapabilityError(
            "SHIP_RICH_TEXT_SCOPE_REQUIRED",
            `clear on field ${JSON.stringify(fieldId)} requires a transaction: "write" operation so the purge intents commit with the owning record`,
            { fieldId },
          );
        }
        const detached = await attachments.detach({ ownerId });
        return Object.freeze(detached.map((object) => object.id));
      },
      migrate: (document) =>
        migrateRichTextDocument(document, {
          fieldId,
          migrations: field.migrations,
          to: schema.version,
        }),
    };
    return Object.freeze(scoped);
  };

  return Object.freeze({
    kind: "ship.rich-text-capability" as const,
    fieldId,
    ...(field.attachment ? { attachmentId: field.attachment.id } : {}),
    withScope,
  });
}

/**
 * The provider the owning module lists so the field's binding resolves. It
 * is a singleton with no dependencies: the executor supplies the scoped
 * attachment capability per run.
 */
export function richTextProvider(
  field: AnyRichText,
  options: RichTextCapabilityOptions = {},
): Provider<RichTextCapability, Record<never, never>, "singleton"> {
  return defineProvider<RichTextCapability, Record<never, never>, "singleton">({
    token: field.binding as RichTextDependencyToken,
    dependencies: {},
    lifetime: "singleton",
    create: () => createRichTextCapability(field, options),
  });
}
