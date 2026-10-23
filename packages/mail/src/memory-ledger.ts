import type {
  MailLedger,
  MailLedgerClaim,
  MailLedgerClaimResult,
  MailLedgerQuery,
  MailSendRecord,
  MailSendStatus,
} from "@sixthsummit/ship-core";

interface MutableRecord {
  idempotencyKey: string;
  mailerId: string;
  message: string;
  to: readonly string[];
  deliveredTo: readonly string[];
  intercepted: boolean;
  subject: string;
  status: MailSendStatus;
  attempts: number;
  provider: string;
  providerMessageId?: string;
  lastError?: string;
  tenantId?: string;
  createdAt: Date;
  claimedAt: Date;
  sentAt?: Date;
  failedAt?: Date;
}

export interface InMemoryMailLedger extends MailLedger {
  readonly adapter: "memory";
  /** Every row, oldest first. */
  readonly records: () => readonly MailSendRecord[];
  readonly reset: () => void;
}

/**
 * Process-local ledger for unit tests and local development. It implements
 * the same claim semantics as the PostgreSQL ledger: a `sent` key is answered
 * without a provider call, a `failed` row or a stale `sending` claim is
 * retaken, and a live `sending` claim reports `in-flight`.
 */
export function createInMemoryMailLedger(): InMemoryMailLedger {
  let rows = new Map<string, MutableRecord>();

  const claim = async (request: MailLedgerClaim): Promise<MailLedgerClaimResult> => {
    const existing = rows.get(request.idempotencyKey);
    if (!existing) {
      rows.set(request.idempotencyKey, {
        idempotencyKey: request.idempotencyKey,
        mailerId: request.mailerId,
        message: request.message,
        to: Object.freeze([...request.to]),
        deliveredTo: Object.freeze([...request.deliveredTo]),
        intercepted: request.intercepted,
        subject: request.subject,
        status: "sending",
        attempts: 1,
        provider: request.provider,
        ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
        createdAt: request.now,
        claimedAt: request.now,
      });
      return Object.freeze({ outcome: "claimed" as const, attempt: 1 });
    }
    if (existing.status === "sent") {
      return Object.freeze({ outcome: "sent" as const, record: snapshot(existing) });
    }
    const stale = existing.claimedAt.getTime() < request.now.getTime() - request.leaseMs;
    if (existing.status === "failed" || stale) {
      existing.status = "sending";
      existing.attempts += 1;
      existing.claimedAt = request.now;
      existing.deliveredTo = Object.freeze([...request.deliveredTo]);
      existing.intercepted = request.intercepted;
      existing.provider = request.provider;
      existing.failedAt = undefined;
      return Object.freeze({ outcome: "claimed" as const, attempt: existing.attempts });
    }
    return Object.freeze({ outcome: "in-flight" as const, record: snapshot(existing) });
  };

  const markSent = async (
    idempotencyKey: string,
    outcome: { readonly providerMessageId?: string; readonly now: Date },
  ) => {
    const row = rows.get(idempotencyKey);
    if (!row) return;
    row.status = "sent";
    row.providerMessageId = outcome.providerMessageId;
    row.lastError = undefined;
    row.sentAt = outcome.now;
    row.failedAt = undefined;
  };

  const markFailed = async (
    idempotencyKey: string,
    outcome: { readonly error: string; readonly now: Date },
  ) => {
    const row = rows.get(idempotencyKey);
    if (!row || row.status !== "sending") return;
    row.status = "failed";
    row.lastError = outcome.error;
    row.failedAt = outcome.now;
  };

  const find = async (idempotencyKey: string) => {
    const row = rows.get(idempotencyKey);
    return row ? snapshot(row) : undefined;
  };

  const list = async (query: MailLedgerQuery) =>
    Object.freeze(
      [...rows.values()]
        .filter(
          (row) =>
            (query.recipient === undefined || row.to.includes(query.recipient)) &&
            (query.mailerId === undefined || row.mailerId === query.mailerId) &&
            (query.message === undefined || row.message === query.message) &&
            (query.tenantId === undefined || row.tenantId === query.tenantId),
        )
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            right.idempotencyKey.localeCompare(left.idempotencyKey),
        )
        .slice(0, query.limit)
        .map(snapshot),
    );

  const cleanup = async (options: { readonly before: Date }) => {
    let deleted = 0;
    for (const [key, row] of rows) {
      if (row.status !== "sending" && row.createdAt.getTime() < options.before.getTime()) {
        rows.delete(key);
        deleted += 1;
      }
    }
    return Object.freeze({ deleted });
  };

  return Object.freeze({
    kind: "ship.mail-ledger" as const,
    adapter: "memory" as const,
    claim,
    markSent,
    markFailed,
    find,
    list,
    cleanup,
    records: () => Object.freeze([...rows.values()].map(snapshot)),
    reset: () => {
      rows = new Map();
    },
  });
}

function snapshot(row: MutableRecord): MailSendRecord {
  return Object.freeze({
    idempotencyKey: row.idempotencyKey,
    mailerId: row.mailerId,
    message: row.message,
    to: row.to,
    deliveredTo: row.deliveredTo,
    intercepted: row.intercepted,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    provider: row.provider,
    ...(row.providerMessageId !== undefined ? { providerMessageId: row.providerMessageId } : {}),
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.tenantId !== undefined ? { tenantId: row.tenantId } : {}),
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.failedAt ? { failedAt: row.failedAt } : {}),
  });
}
