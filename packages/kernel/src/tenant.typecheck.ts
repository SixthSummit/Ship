// Compile-only public contract checks. This file is included by tsconfig.check.json.
import {
  createTenantBypassAuthority,
  createTenantScopeAuthority,
  operationActor,
  type TenantBypass,
  type TenantScope,
} from "./index.js";

const actor = operationActor({ id: "actor-1" });
const scopeAuthority = createTenantScopeAuthority({
  id: "accounts.tenant-scope",
  authorize: ({ actor, tenantId }) => actor.id.length > 0 && String(tenantId).length > 0,
});
const scope = await scopeAuthority.issue({
  tenantId: "tenant-a",
  requestId: "request-1",
  actor,
});
const exactTenant: "tenant-a" = scope.tenantId;

const authority = createTenantBypassAuthority({
  id: "platform.tenant-bypass",
  audit: (event) => {
    const requestId: string = event.requestId;
    if (event.action === "repository-accessed") {
      const repositoryId: string = event.repositoryId;
      repositoryId satisfies string;
    }
    requestId satisfies string;
  },
});
const bypass: TenantBypass = authority.issue({
  requestId: "request-1",
  actor,
  reason: "repair tenant-owned data",
});

// The unexported brand prevents structural capability fabrication.
// @ts-expect-error tenant scopes must come from a scope authority
const forgedScope: TenantScope<string> = {
  kind: "ship.tenant-scope",
  tenantId: "tenant-a",
  requestId: "request-1",
};
// @ts-expect-error tenant bypasses must come from an authority
const forgedBypass: TenantBypass = {
  kind: "ship.tenant-bypass",
  authorityId: "platform.tenant-bypass",
  requestId: "request-1",
  actorId: "actor-1",
  reason: "repair tenant-owned data",
};

exactTenant satisfies "tenant-a";
bypass satisfies TenantBypass;
void forgedScope;
void forgedBypass;
