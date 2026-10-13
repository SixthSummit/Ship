// Compile-only public contract checks. This file is included by tsconfig.check.json.

import {
  createTenantBypassAuthority,
  createTenantScopeAuthority,
  operationActor,
} from "@sixthsummit/ship-core";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { createTenantRepository, tenantPredicate } from "./index.js";

const stringTenantRecords = pgTable("string_tenant_records", {
  id: serial("id").primaryKey(),
  tenantId: text("tenantId").notNull(),
});
const numericTenantRecords = pgTable("numeric_tenant_records", {
  id: serial("id").primaryKey(),
  tenantId: serial("tenantId").notNull(),
});
const transaction = { id: "transaction-1" };
const actor = operationActor({ id: "operator-1" });

const scopedOnly = createTenantRepository({
  id: "records.scoped",
  transaction,
  createScoped: ({ transaction: active, scope }) => ({
    transactionId: active.id,
    tenantId: scope.tenantId,
    find: (id: number) => ({ id }),
  }),
});
const privileged = createTenantRepository({
  id: "records.privileged",
  transaction,
  createScoped: ({ scope }) => ({ tenantId: scope.tenantId }),
  createPrivileged: ({ bypass }) => ({
    authorityId: bypass.authorityId,
    listEveryTenant: () => [] as { readonly tenantId: string }[],
  }),
});
const scopeAuthority = createTenantScopeAuthority({
  id: "records.tenant-scope",
  authorize: () => true,
});
const stringScope = await scopeAuthority.issue({
  tenantId: "tenant-a",
  requestId: "request-1",
  actor,
});
const numberScope = await scopeAuthority.issue({ tenantId: 42, requestId: "request-1", actor });
const bypass = createTenantBypassAuthority({
  id: "platform.bypass",
  audit: () => undefined,
}).issue({ requestId: "request-1", actor, reason: "support" });

const scopedRepository = scopedOnly.forTenant(stringScope);
const recordId: number = scopedRepository.find(1).id;
const privilegedRepository = privileged.withBypass(bypass);
privilegedRepository.listEveryTenant();
tenantPredicate(stringTenantRecords.tenantId, stringScope);
tenantPredicate(numericTenantRecords.tenantId, numberScope);

// @ts-expect-error tenant scope is required
scopedOnly.forTenant();
// @ts-expect-error a bypass is not a tenant scope
scopedOnly.forTenant(bypass);
// @ts-expect-error scoped-only repositories do not expose bypass construction
scopedOnly.withBypass(bypass);
// @ts-expect-error a tenant scope is not privileged bypass evidence
privileged.withBypass(stringScope);
// @ts-expect-error the tenant identifier must match the database column
tenantPredicate(stringTenantRecords.tenantId, numberScope);
// @ts-expect-error privileged APIs do not leak into scoped repository types
privileged.forTenant(stringScope).listEveryTenant();

recordId satisfies number;
