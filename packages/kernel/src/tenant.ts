import type { OperationActor } from "./actor.js";
import { isOperationActor, operationActor } from "./actor.js";

const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const tenantScopeBrand: unique symbol = Symbol("ship.tenant-scope.brand");
const tenantBypassBrand: unique symbol = Symbol("ship.tenant-bypass.brand");
const authenticTenantScopes = new WeakSet<object>();
const authenticTenantBypasses = new WeakMap<object, TenantBypassRecord>();

export type TenantIdentifier = string | number;

export interface TenantScope<TTenantId extends TenantIdentifier = TenantIdentifier> {
  readonly kind: "ship.tenant-scope";
  readonly tenantId: TTenantId;
  readonly requestId: string;
  readonly actorId: string;
  readonly [tenantScopeBrand]: true;
}

export interface TenantScopeRequest<TTenantId extends TenantIdentifier> {
  readonly tenantId: TTenantId;
  /** Request, job, or message invocation that selected this tenant. */
  readonly requestId: string;
  readonly actor: OperationActor;
}

export interface TenantScopeAuthority {
  readonly kind: "ship.tenant-scope-authority";
  readonly id: string;
  issue<const TTenantId extends TenantIdentifier>(
    request: TenantScopeRequest<TTenantId>,
  ): Promise<TenantScope<TTenantId>>;
}

export interface TenantBypass {
  readonly kind: "ship.tenant-bypass";
  readonly authorityId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly [tenantBypassBrand]: true;
}

export interface TenantBypassRequest {
  readonly requestId: string;
  readonly actor: OperationActor;
  /** Human-readable purpose retained in every audit event. */
  readonly reason: string;
}

export type TenantBypassAuditEvent =
  | {
      readonly kind: "ship.tenant-bypass-audit";
      readonly action: "issued";
      readonly authorityId: string;
      readonly requestId: string;
      readonly actorId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "ship.tenant-bypass-audit";
      readonly action: "repository-accessed";
      readonly authorityId: string;
      readonly repositoryId: string;
      readonly requestId: string;
      readonly actorId: string;
      readonly reason: string;
    };

export type TenantBypassAuditSink = (event: TenantBypassAuditEvent) => void;

export interface TenantBypassAuthority {
  readonly kind: "ship.tenant-bypass-authority";
  readonly id: string;
  issue(request: TenantBypassRequest): TenantBypass;
}

export type TenantCapabilityErrorCode =
  | "SHIP_TENANT_SCOPE_AUTHORITY_INVALID"
  | "SHIP_TENANT_SCOPE_REQUEST_INVALID"
  | "SHIP_TENANT_SCOPE_FORBIDDEN"
  | "SHIP_TENANT_SCOPE_AUTHORIZATION_FAILED"
  | "SHIP_TENANT_BYPASS_AUTHORITY_INVALID"
  | "SHIP_TENANT_BYPASS_REQUEST_INVALID"
  | "SHIP_TENANT_BYPASS_REQUIRED"
  | "SHIP_TENANT_BYPASS_AUDIT_FAILED";

export class TenantCapabilityError extends Error {
  readonly code: TenantCapabilityErrorCode;
  readonly field?: string;
  readonly authorityId?: string;
  readonly repositoryId?: string;
  readonly tenantId?: TenantIdentifier;

  constructor(
    code: TenantCapabilityErrorCode,
    message: string,
    options: {
      readonly field?: string;
      readonly authorityId?: string;
      readonly repositoryId?: string;
      readonly tenantId?: TenantIdentifier;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TenantCapabilityError";
    this.code = code;
    this.field = options.field;
    this.authorityId = options.authorityId;
    this.repositoryId = options.repositoryId;
    this.tenantId = options.tenantId;
  }
}

export function isTenantScope(value: unknown): value is TenantScope {
  return typeof value === "object" && value !== null && authenticTenantScopes.has(value);
}

/**
 * Defines the application-owned policy that may issue authenticated tenant scopes.
 * Repositories accept only capabilities issued through this boundary.
 */
export function createTenantScopeAuthority(definition: {
  readonly id: string;
  readonly authorize: (request: TenantScopeRequest<TenantIdentifier>) => boolean | Promise<boolean>;
}): TenantScopeAuthority {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    throw scopeAuthorityError("tenant scope authority definition must be an object");
  }
  if (typeof definition.id !== "string" || !CAPABILITY_ID_PATTERN.test(definition.id)) {
    throw scopeAuthorityError(
      `tenant scope authority id must be a lowercase dot-separated identifier; received ${JSON.stringify(definition.id)}`,
      "id",
    );
  }
  if (typeof definition.authorize !== "function") {
    throw scopeAuthorityError(
      "tenant scope authority must provide authorize(request)",
      "authorize",
      definition.id,
    );
  }

  const issue = async <const TTenantId extends TenantIdentifier>(
    request: TenantScopeRequest<TTenantId>,
  ): Promise<TenantScope<TTenantId>> => {
    assertScopeRequest(request, definition.id);
    const frozenRequest = Object.freeze({
      tenantId: request.tenantId,
      requestId: request.requestId,
      actor: operationActor(request.actor),
    });
    assertScopeRequest(frozenRequest, definition.id);
    let authorized: unknown;
    try {
      authorized = await definition.authorize(frozenRequest);
    } catch (cause) {
      throw new TenantCapabilityError(
        "SHIP_TENANT_SCOPE_AUTHORIZATION_FAILED",
        `tenant scope authority ${JSON.stringify(definition.id)} failed to authorize access`,
        { authorityId: definition.id, tenantId: frozenRequest.tenantId, cause },
      );
    }
    if (typeof authorized !== "boolean") {
      throw new TenantCapabilityError(
        "SHIP_TENANT_SCOPE_AUTHORIZATION_FAILED",
        `tenant scope authority ${JSON.stringify(definition.id)} must return a boolean`,
        { authorityId: definition.id, tenantId: frozenRequest.tenantId },
      );
    }
    if (!authorized) {
      throw new TenantCapabilityError(
        "SHIP_TENANT_SCOPE_FORBIDDEN",
        `actor ${JSON.stringify(frozenRequest.actor.id)} is not authorized for tenant ${JSON.stringify(frozenRequest.tenantId)}`,
        { authorityId: definition.id, tenantId: frozenRequest.tenantId },
      );
    }
    return issueTenantScope(frozenRequest);
  };

  return Object.freeze({
    kind: "ship.tenant-scope-authority" as const,
    id: definition.id,
    issue,
  });
}

export function isTenantBypass(value: unknown): value is TenantBypass {
  return typeof value === "object" && value !== null && authenticTenantBypasses.has(value);
}

/**
 * Creates the only component allowed to issue privileged tenant bypasses.
 * The audit sink is synchronous so authorization cannot race persistence.
 */
export function createTenantBypassAuthority(definition: {
  readonly id: string;
  readonly audit: TenantBypassAuditSink;
}): TenantBypassAuthority {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    throw authorityError("tenant bypass authority definition must be an object");
  }
  if (typeof definition.id !== "string" || !CAPABILITY_ID_PATTERN.test(definition.id)) {
    throw authorityError(
      `tenant bypass authority id must be a lowercase dot-separated identifier; received ${JSON.stringify(definition.id)}`,
      "id",
    );
  }
  if (typeof definition.audit !== "function") {
    throw authorityError(
      "tenant bypass authority must provide audit(event)",
      "audit",
      definition.id,
    );
  }

  const issue = (request: TenantBypassRequest): TenantBypass => {
    assertBypassRequest(request, definition.id);
    const bypass = Object.freeze({
      kind: "ship.tenant-bypass" as const,
      authorityId: definition.id,
      requestId: request.requestId,
      actorId: request.actor.id,
      reason: request.reason,
      [tenantBypassBrand]: true as const,
    });
    const record = Object.freeze({ bypass, audit: definition.audit });
    recordAudit(record, {
      kind: "ship.tenant-bypass-audit",
      action: "issued",
      authorityId: definition.id,
      requestId: request.requestId,
      actorId: request.actor.id,
      reason: request.reason,
    });
    authenticTenantBypasses.set(bypass, record);
    return bypass;
  };

  return Object.freeze({
    kind: "ship.tenant-bypass-authority" as const,
    id: definition.id,
    issue,
  });
}

/** @internal Called by persistence adapters at the privileged construction site. */
export function recordTenantBypassUse(
  value: unknown,
  repositoryId: string,
): asserts value is TenantBypass {
  const record =
    typeof value === "object" && value !== null ? authenticTenantBypasses.get(value) : undefined;
  if (!record) {
    throw new TenantCapabilityError(
      "SHIP_TENANT_BYPASS_REQUIRED",
      "privileged tenant access requires an authentic tenant bypass",
      { repositoryId },
    );
  }
  if (!CAPABILITY_ID_PATTERN.test(repositoryId)) {
    throw new TenantCapabilityError(
      "SHIP_TENANT_BYPASS_REQUIRED",
      `tenant repository id must be a lowercase dot-separated identifier; received ${JSON.stringify(repositoryId)}`,
      { field: "repositoryId", authorityId: record.bypass.authorityId, repositoryId },
    );
  }
  recordAudit(record, {
    kind: "ship.tenant-bypass-audit",
    action: "repository-accessed",
    authorityId: record.bypass.authorityId,
    repositoryId,
    requestId: record.bypass.requestId,
    actorId: record.bypass.actorId,
    reason: record.bypass.reason,
  });
}

interface TenantBypassRecord {
  readonly bypass: TenantBypass;
  readonly audit: TenantBypassAuditSink;
}

function assertTenantIdentifier(value: unknown): asserts value is TenantIdentifier {
  const validString = typeof value === "string" && value.length > 0 && value.trim() === value;
  const validNumber = typeof value === "number" && Number.isSafeInteger(value);
  if (!validString && !validNumber) {
    throw new TenantCapabilityError(
      "SHIP_TENANT_SCOPE_REQUEST_INVALID",
      "tenantId must be a non-empty trimmed string or safe integer",
      { field: "tenantId" },
    );
  }
}

function assertScopeRequest(
  value: unknown,
  authorityId: string,
): asserts value is TenantScopeRequest<TenantIdentifier> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TenantCapabilityError(
      "SHIP_TENANT_SCOPE_REQUEST_INVALID",
      "tenant scope request must be an object",
      { authorityId },
    );
  }
  try {
    assertTenantIdentifier(Reflect.get(value, "tenantId"));
  } catch (error) {
    if (error instanceof TenantCapabilityError) {
      throw new TenantCapabilityError(error.code, error.message, {
        field: error.field,
        authorityId,
      });
    }
    throw error;
  }
  assertEvidenceString(
    Reflect.get(value, "requestId"),
    "requestId",
    "SHIP_TENANT_SCOPE_REQUEST_INVALID",
    authorityId,
  );
  if (!isOperationActor(Reflect.get(value, "actor"))) {
    throw new TenantCapabilityError(
      "SHIP_TENANT_SCOPE_REQUEST_INVALID",
      "tenant scope request must provide an operation actor",
      { field: "actor", authorityId },
    );
  }
}

function issueTenantScope<const TTenantId extends TenantIdentifier>(
  request: TenantScopeRequest<TTenantId>,
): TenantScope<TTenantId> {
  const scope = Object.freeze({
    kind: "ship.tenant-scope" as const,
    tenantId: request.tenantId,
    requestId: request.requestId,
    actorId: request.actor.id,
    [tenantScopeBrand]: true as const,
  });
  authenticTenantScopes.add(scope);
  return scope;
}

function assertBypassRequest(
  value: unknown,
  authorityId: string,
): asserts value is TenantBypassRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TenantCapabilityError(
      "SHIP_TENANT_BYPASS_REQUEST_INVALID",
      "tenant bypass request must be an object",
      { authorityId },
    );
  }
  for (const field of ["requestId", "reason"] as const) {
    assertEvidenceString(
      Reflect.get(value, field),
      field,
      "SHIP_TENANT_BYPASS_REQUEST_INVALID",
      authorityId,
    );
  }
  if (!isOperationActor(Reflect.get(value, "actor"))) {
    throw new TenantCapabilityError(
      "SHIP_TENANT_BYPASS_REQUEST_INVALID",
      "tenant bypass request must provide an operation actor",
      { field: "actor", authorityId },
    );
  }
}

function assertEvidenceString(
  value: unknown,
  field: string,
  code: TenantCapabilityErrorCode,
  authorityId?: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TenantCapabilityError(code, `${field} must be a non-empty trimmed string`, {
      field,
      authorityId,
    });
  }
}

function recordAudit(record: TenantBypassRecord, event: TenantBypassAuditEvent): void {
  const frozenEvent = Object.freeze(event);
  let result: unknown;
  try {
    result = record.audit(frozenEvent);
  } catch (cause) {
    throw auditError(record, event, cause);
  }
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => undefined);
    throw auditError(record, event, new TypeError("tenant bypass audit sink must be synchronous"));
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function auditError(
  record: TenantBypassRecord,
  event: TenantBypassAuditEvent,
  cause: unknown,
): TenantCapabilityError {
  return new TenantCapabilityError(
    "SHIP_TENANT_BYPASS_AUDIT_FAILED",
    `tenant bypass audit failed during ${event.action}`,
    {
      authorityId: record.bypass.authorityId,
      ...(event.action === "repository-accessed" ? { repositoryId: event.repositoryId } : {}),
      cause,
    },
  );
}

function authorityError(
  message: string,
  field?: string,
  authorityId?: string,
): TenantCapabilityError {
  return new TenantCapabilityError("SHIP_TENANT_BYPASS_AUTHORITY_INVALID", message, {
    field,
    authorityId,
  });
}

function scopeAuthorityError(
  message: string,
  field?: string,
  authorityId?: string,
): TenantCapabilityError {
  return new TenantCapabilityError("SHIP_TENANT_SCOPE_AUTHORITY_INVALID", message, {
    field,
    authorityId,
  });
}
