import { contractSchema } from "@sixthsummit/ship-contract/schema";
import {
  defineAttachment,
  defineOperation,
  defineRichText,
  defineRichTextExtension,
  type OperationContext,
  type OperationErrorDefinition,
  objectSchema,
  operationError,
  operationFailure,
  permission,
  stringSchema,
  type TenantScope,
  type UnitOfWorkDependencyToken,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import {
  RichTextCapabilityError,
  richTextDocumentSchema,
  richTextIssuesSchema,
} from "@sixthsummit/ship-rich-text";
import { z } from "zod";
import type { PortfolioCapabilities } from "./repository.js";

/**
 * Images embedded in document bodies. They are objects of this attachment,
 * so the storage module's intent, completion, sweep and purge lifecycle
 * applies to them exactly as to project photos; the document body is what
 * attaches and detaches them.
 */
export const documentImage = defineAttachment({
  id: "portfolio.document-image",
  cardinality: "many",
  contentTypes: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 5_000_000,
  visibility: "private",
  maxCount: 50,
});

/**
 * A named, reviewable widening of the base schema: an inline merge field
 * (`{{client.name}}`) that a template renders as a placeholder chip. The
 * structural spec reaches the editor through the manifest; the renderers
 * stay on the server.
 */
export const mergeField = defineRichTextExtension({
  name: "merge-field",
  nodes: {
    mergeField: {
      spec: {
        group: "inline",
        atom: true,
        attrs: { key: { type: "string", required: true, maxLength: 64 } },
      },
      validate: (attrs) =>
        /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/u.test(String(attrs.key))
          ? undefined
          : "key must be a dotted identifier such as client.name",
      renderHtml: (node, { attribute }) =>
        `<span class="merge-field" data-key="${attribute(node.attrs?.key)}">{{${attribute(node.attrs?.key)}}}</span>`,
      renderText: (node) => `{{${String(node.attrs?.key ?? "")}}}`,
    },
  },
});

/**
 * The document body: the kernel's base allowlist plus the merge field, with
 * embedded images drawn from `documentImage`. Stored as the sanitized
 * document model (ProseMirror JSON plus `schemaVersion`), never HTML.
 */
export const documentBody = defineRichText({
  id: "portfolio.document-body",
  attachment: documentImage,
  extensions: [mergeField],
  maxBytes: 256 * 1024,
  links: { rel: "noopener noreferrer" },
});

const documentParamsSchema = contractSchema(
  z.object({ tenantId: z.string().trim().min(1), documentId: z.string().uuid() }),
  {
    jsonSchema: {
      type: "object",
      required: ["tenantId", "documentId"],
      properties: {
        tenantId: { type: "string", minLength: 1 },
        documentId: { type: "string", format: "uuid" },
      },
    },
  },
);
/**
 * The body goes through the field's full allowlist at the input boundary, so
 * a refused document is a `VALIDATION_ERROR` with path-addressed issues
 * before the handler runs; `save` validates again and reconciles the embeds.
 */
const saveBodySchema = objectSchema({
  title: stringSchema({ minLength: 1 }),
  document: richTextDocumentSchema(documentBody),
});
const documentSchema = contractSchema(
  z.object({
    documentId: z.string().uuid(),
    title: z.string(),
    html: z.string(),
    text: z.string(),
    attachments: z.array(z.string()),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["documentId", "title", "html", "text", "attachments"],
      properties: {
        documentId: { type: "string", format: "uuid" },
        title: { type: "string" },
        html: { type: "string" },
        text: { type: "string" },
        attachments: { type: "array", items: { type: "string" } },
      },
    },
  },
);
const savedSchema = contractSchema(
  z.object({
    documentId: z.string().uuid(),
    text: z.string(),
    attached: z.array(z.string()),
    detached: z.array(z.string()),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["documentId", "text", "attached", "detached"],
      properties: {
        documentId: { type: "string", format: "uuid" },
        text: { type: "string" },
        attached: { type: "array", items: { type: "string" } },
        detached: { type: "array", items: { type: "string" } },
      },
    },
  },
);
const deletedSchema = contractSchema(
  z.object({ deleted: z.boolean(), purging: z.array(z.string()) }),
  {
    jsonSchema: {
      type: "object",
      required: ["deleted", "purging"],
      properties: {
        deleted: { type: "boolean" },
        purging: { type: "array", items: { type: "string" } },
      },
    },
  },
);

export const documentInvalid = operationError({
  code: "DOCUMENT_INVALID",
  status: 422,
  message: "The document references content the field does not allow",
  details: richTextIssuesSchema(),
});
export const documentNotFound = operationError({
  code: "DOCUMENT_NOT_FOUND",
  status: 404,
  message: "No such document in this tenant",
});

export interface DocumentOperationOptions {
  readonly portfolioUnitOfWork: UnitOfWorkDependencyToken<PortfolioCapabilities>;
  readonly authorizeTenant: (
    tenantId: string,
    context: OperationContext,
  ) => Promise<TenantScope<string>>;
  readonly tenantAccessDenied: OperationErrorDefinition;
}

/** The owner id folds the authentic tenant in, so one tenant can never reach another's embeds. */
function ownerFor(scope: TenantScope<string>, documentId: string): string {
  return `${scope.tenantId}/document/${documentId}`;
}

/**
 * Three operations over the declared field: save (validate, reconcile the
 * embedded images in the same transaction as the row), read (render HTML
 * with signed URLs resolved now, plus the stored text projection) and delete
 * (the row and every embedded image's purge intent commit together).
 */
export function defineDocumentOperations(options: DocumentOperationOptions) {
  const save = defineOperation({
    id: "portfolio.save-document",
    transport: http.put("/tenants/:tenantId/documents/:documentId"),
    input: { params: documentParamsSchema, body: saveBodySchema },
    output: { 200: savedSchema },
    successStatus: 200,
    errors: [options.tenantAccessDenied, documentInvalid],
    access: permission("portfolio:write"),
    transaction: "write",
    dependencies: { tx: options.portfolioUnitOfWork, body: documentBody.binding },
    handler: async ({ input, services, context }) => {
      const scope = await options.authorizeTenant(input.params.tenantId, context);
      const ownerId = ownerFor(scope, input.params.documentId);
      try {
        const saved = await services.body.save({ ownerId, document: input.body.document });
        await services.tx.portfolio.forTenant(scope).upsertDocument({
          id: input.params.documentId,
          title: input.body.title,
          body: saved.document,
          bodyText: saved.text,
        });
        return {
          documentId: input.params.documentId,
          text: saved.text,
          attached: Array.from(saved.attached),
          detached: Array.from(saved.detached),
        };
      } catch (error) {
        if (error instanceof RichTextCapabilityError && error.code === "SHIP_RICH_TEXT_INVALID") {
          throw operationFailure(documentInvalid, { details: { issues: error.issues } });
        }
        throw error;
      }
    },
  });

  const read = defineOperation({
    id: "portfolio.document",
    transport: http.get("/tenants/:tenantId/documents/:documentId"),
    input: { params: documentParamsSchema },
    output: { 200: documentSchema },
    successStatus: 200,
    errors: [options.tenantAccessDenied, documentNotFound],
    access: permission("portfolio:read"),
    transaction: "read",
    dependencies: { tx: options.portfolioUnitOfWork, body: documentBody.binding },
    handler: async ({ input, services, context }) => {
      const scope = await options.authorizeTenant(input.params.tenantId, context);
      const row = await services.tx.portfolio
        .forTenant(scope)
        .readDocument(input.params.documentId);
      if (!row) throw operationFailure(documentNotFound);
      return {
        documentId: row.id,
        title: row.title,
        html: await services.body.render(row.body),
        text: row.bodyText,
        attachments: Array.from(services.body.attachments(row.body)),
      };
    },
  });

  const remove = defineOperation({
    id: "portfolio.delete-document",
    transport: http.delete("/tenants/:tenantId/documents/:documentId"),
    input: { params: documentParamsSchema },
    output: { 200: deletedSchema },
    successStatus: 200,
    errors: [options.tenantAccessDenied],
    access: permission("portfolio:write"),
    transaction: "write",
    dependencies: { tx: options.portfolioUnitOfWork, body: documentBody.binding },
    handler: async ({ input, services, context }) => {
      const scope = await options.authorizeTenant(input.params.tenantId, context);
      const deleted = await services.tx.portfolio
        .forTenant(scope)
        .deleteDocument(input.params.documentId);
      // Embedded images live exactly as long as the row: their purge intents
      // commit in this transaction and the storage outbox deletes the bytes.
      const purging = deleted
        ? await services.body.clear({ ownerId: ownerFor(scope, input.params.documentId) })
        : [];
      return { deleted, purging: Array.from(purging) };
    },
  });

  return { save, read, remove };
}
