/** Channels and auth shared by the API and gateway fixture processes. */
import {
  createTenantScopeAuthority,
  defineActorResolver,
  defineChannel,
  operationActor,
} from "@sixthsummit/ship-core";
import { defineHonoCredentialAdapter } from "@sixthsummit/ship-hono";
import { z } from "zod";

export const feed = defineChannel({
  id: "fixture.feed",
  scope: "actor",
  payload: z.object({ n: z.number(), sentAt: z.number(), padding: z.string().optional() }),
});

export const room = defineChannel({
  id: "fixture.room",
  scope: "tenant",
  payload: z.object({ n: z.number(), sentAt: z.number() }),
  presence: true,
});

export const strict = defineChannel({
  id: "fixture.strict",
  scope: "actor",
  payload: z.object({ n: z.number(), sentAt: z.number(), padding: z.string().optional() }),
  slowSubscriber: "disconnect",
});

export const channels = [feed, room, strict];

export const credentials = defineHonoCredentialAdapter<string>({
  id: "fixture.bearer",
  extract: (request) => request.headers.get("authorization")?.replace(/^Bearer /u, ""),
});

/** The credential is the actor id; every actor belongs to tenant "acme". */
export const actors = defineActorResolver<string>({
  id: "fixture.actors",
  resolve: ({ credential }) =>
    credential === undefined || credential.length === 0
      ? { ok: false, reason: "invalid-credential" }
      : { ok: true, actor: operationActor({ id: credential, permissions: ["tenant:acme"] }) },
});

export const tenantScopes = createTenantScopeAuthority({
  id: "fixture.tenants",
  authorize: ({ actor, tenantId }) => actor.permissions?.has(`tenant:${tenantId}`) ?? false,
});

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}
