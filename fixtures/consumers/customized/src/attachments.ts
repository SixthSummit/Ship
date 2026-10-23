import { contractSchema } from "@sixthsummit/ship-contract/schema";
import {
  type AttachmentObject,
  defineAttachment,
  defineOperation,
  type OperationContext,
  type OperationErrorDefinition,
  operationError,
  operationFailure,
  permission,
  type TenantScope,
  type UnitOfWorkDependencyToken,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { AttachmentCapabilityError } from "@sixthsummit/ship-storage";
import { z } from "zod";
import type { PortfolioCapabilities } from "./repository.js";

/**
 * Project photos: a `many` attachment owned by the portfolio module. The
 * declaration carries the upload policy the client contract projects; the
 * storage module mounted in `application.ts` supplies the adapter, ledger and
 * purge outbox, so this file never names a provider.
 */
export const projectPhoto = defineAttachment({
  id: "portfolio.photo",
  cardinality: "many",
  contentTypes: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 5_000_000,
  visibility: "private",
  maxCount: 12,
  intentTtlMs: 15 * 60 * 1000,
  variants: { thumb: { width: 320, height: 320, fit: "cover", format: "webp" } },
});

const projectParamsSchema = contractSchema(
  z.object({ tenantId: z.string().trim().min(1), projectId: z.string().uuid() }),
  {
    jsonSchema: {
      type: "object",
      required: ["tenantId", "projectId"],
      properties: {
        tenantId: { type: "string", minLength: 1 },
        projectId: { type: "string", format: "uuid" },
      },
    },
  },
);
const photoParamsSchema = contractSchema(
  z.object({
    tenantId: z.string().trim().min(1),
    projectId: z.string().uuid(),
    objectId: z.string().uuid(),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["tenantId", "projectId", "objectId"],
      properties: {
        tenantId: { type: "string", minLength: 1 },
        projectId: { type: "string", format: "uuid" },
        objectId: { type: "string", format: "uuid" },
      },
    },
  },
);
const attachBodySchema = contractSchema(z.object({ objectId: z.string().uuid() }), {
  jsonSchema: {
    type: "object",
    required: ["objectId"],
    properties: { objectId: { type: "string", format: "uuid" } },
  },
});
const photoSchema = z.object({
  objectId: z.string().uuid(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
  thumb: z.string().nullable(),
});
const photoJsonSchema = {
  type: "object",
  required: ["objectId", "contentType", "size", "url", "thumb"],
  properties: {
    objectId: { type: "string", format: "uuid" },
    contentType: { type: "string" },
    size: { type: "integer", minimum: 0 },
    url: { type: "string" },
    thumb: { type: ["string", "null"] },
  },
} as const;
const attachedSchema = contractSchema(
  z.object({ objectId: z.string().uuid(), count: z.number().int() }),
  {
    jsonSchema: {
      type: "object",
      required: ["objectId", "count"],
      properties: { objectId: { type: "string", format: "uuid" }, count: { type: "integer" } },
    },
  },
);
const removedSchema = contractSchema(z.object({ removed: z.boolean() }), {
  jsonSchema: {
    type: "object",
    required: ["removed"],
    properties: { removed: { type: "boolean" } },
  },
});
const photosSchema = contractSchema(z.object({ photos: z.array(photoSchema) }), {
  jsonSchema: {
    type: "object",
    required: ["photos"],
    properties: { photos: { type: "array", items: photoJsonSchema } },
  },
});

export const photoUnavailable = operationError({
  code: "PHOTO_UNAVAILABLE",
  status: 409,
  message: "The uploaded object is not available to attach",
});
export const photoLimitReached = operationError({
  code: "PHOTO_LIMIT_REACHED",
  status: 409,
  message: "The project already holds the maximum number of photos",
});

export interface ProjectPhotoOperationOptions {
  readonly portfolioUnitOfWork: UnitOfWorkDependencyToken<PortfolioCapabilities>;
  readonly authorizeTenant: (
    tenantId: string,
    context: OperationContext,
  ) => Promise<TenantScope<string>>;
  readonly tenantAccessDenied: OperationErrorDefinition;
}

/** The owner id folds the authentic tenant in, so one tenant can never list another's photos. */
function ownerFor(scope: TenantScope<string>, projectId: string): string {
  return `${scope.tenantId}/${projectId}`;
}

/**
 * Three operations over the declared attachment: attach a completed upload to
 * a project, remove one (which commits the purge intent with the detachment),
 * and list a project's photos with signed URLs and lazily rendered thumbnails.
 */
export function defineProjectPhotoOperations(options: ProjectPhotoOperationOptions) {
  const attach = defineOperation({
    id: "portfolio.attach-photo",
    transport: http.post("/tenants/:tenantId/projects/:projectId/photos"),
    input: { params: projectParamsSchema, body: attachBodySchema },
    output: { 201: attachedSchema },
    successStatus: 201,
    errors: [options.tenantAccessDenied, photoUnavailable, photoLimitReached],
    access: permission("portfolio:write"),
    transaction: "write",
    dependencies: { tx: options.portfolioUnitOfWork, photos: projectPhoto.binding },
    attachments: [projectPhoto],
    handler: async ({ input, services, context }) => {
      const scope = await options.authorizeTenant(input.params.tenantId, context);
      const ownerId = ownerFor(scope, input.params.projectId);
      try {
        const object = await services.photos.attach({ ownerId, objectId: input.body.objectId });
        const count = (await services.photos.list(ownerId)).length;
        return { objectId: object.id, count };
      } catch (error) {
        if (error instanceof AttachmentCapabilityError) {
          throw operationFailure(
            error.code === "SHIP_ATTACHMENT_LIMIT_EXCEEDED" ? photoLimitReached : photoUnavailable,
          );
        }
        throw error;
      }
    },
  });

  const remove = defineOperation({
    id: "portfolio.remove-photo",
    transport: http.delete("/tenants/:tenantId/projects/:projectId/photos/:objectId"),
    input: { params: photoParamsSchema },
    output: { 200: removedSchema },
    successStatus: 200,
    errors: [options.tenantAccessDenied],
    access: permission("portfolio:write"),
    transaction: "write",
    dependencies: { tx: options.portfolioUnitOfWork, photos: projectPhoto.binding },
    attachments: [projectPhoto],
    handler: async ({ input, services, context }) => {
      const scope = await options.authorizeTenant(input.params.tenantId, context);
      const detached = await services.photos.detach({
        ownerId: ownerFor(scope, input.params.projectId),
        objectId: input.params.objectId,
      });
      return { removed: detached.length > 0 };
    },
  });

  const list = defineOperation({
    id: "portfolio.photos",
    transport: http.get("/tenants/:tenantId/projects/:projectId/photos"),
    input: { params: projectParamsSchema },
    output: { 200: photosSchema },
    successStatus: 200,
    errors: [options.tenantAccessDenied],
    access: permission("portfolio:read"),
    transaction: "none",
    dependencies: { photos: projectPhoto.binding },
    attachments: [projectPhoto],
    handler: async ({ input, services, context }) => {
      const scope = await options.authorizeTenant(input.params.tenantId, context);
      const objects = await services.photos.list(ownerFor(scope, input.params.projectId));
      const photos = await Promise.all(
        objects.map(async (object: AttachmentObject) => {
          const url = await services.photos.url(object.id);
          const thumb = await services.photos.variant(object.id, "thumb");
          return {
            objectId: object.id,
            contentType: object.contentType,
            size: object.size,
            url: url?.url ?? "",
            thumb: thumb?.status === "ready" ? thumb.url.url : null,
          };
        }),
      );
      return { photos };
    },
  });

  return { attach, remove, list };
}
