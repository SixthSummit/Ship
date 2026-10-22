import type { MailEnvelope, MailInterception, MailInterceptor } from "@sixthsummit/ship-core";
import { isMailAddress, MAIL_ORIGINAL_TO_HEADER } from "@sixthsummit/ship-core";

export interface AllowlistInterceptorOptions {
  /**
   * Addresses (`qa@example.test`) or domains (`@example.test`) that may be
   * delivered to as addressed. Matching is case-insensitive on the address.
   */
  readonly allow: readonly string[];
  /** Where every other recipient is redirected; must contain at least one address. */
  readonly redirectTo: readonly string[];
  /** Prefix the subject with the original recipients, for example `[to: a@b.c] Subject`. Defaults to true. */
  readonly subjectPrefix?: boolean;
}

export class MailInterceptorError extends Error {
  readonly code = "SHIP_MAIL_INTERCEPTOR_INVALID";
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "MailInterceptorError";
    this.field = field;
  }
}

/**
 * Non-production guard: a recipient outside the allowlist is replaced by the
 * redirect inbox, `cc`/`bcc` outside it are dropped (the inbox already gets
 * the message), the original recipients travel in `X-Ship-Original-To` and
 * the subject is prefixed so the inbox reader can tell who it was for. A send
 * whose recipients are all allowed passes through untouched and is recorded
 * as not intercepted.
 */
export function allowlistInterceptor(options: AllowlistInterceptorOptions): MailInterceptor {
  assertOptions(options);
  const allowedAddresses = new Set(
    options.allow.filter((entry) => !entry.startsWith("@")).map((entry) => normalize(entry)),
  );
  const allowedDomains = new Set(
    options.allow.filter((entry) => entry.startsWith("@")).map((entry) => entry.toLowerCase()),
  );
  const redirectTo = Object.freeze([...options.redirectTo]);
  const prefix = options.subjectPrefix ?? true;
  const allowed = (recipient: string) => {
    const address = normalize(recipient);
    const domain = address.slice(address.lastIndexOf("@"));
    return allowedAddresses.has(address) || allowedDomains.has(domain);
  };

  const intercept = (envelope: MailEnvelope): MailInterception => {
    const to = envelope.to.filter(allowed);
    const cc = (envelope.cc ?? []).filter(allowed);
    const bcc = (envelope.bcc ?? []).filter(allowed);
    const unchanged =
      to.length === envelope.to.length &&
      cc.length === (envelope.cc ?? []).length &&
      bcc.length === (envelope.bcc ?? []).length;
    if (unchanged) return Object.freeze({ envelope, intercepted: false });

    const original = [
      ...envelope.to,
      ...(envelope.cc ?? []).map((address) => `cc:${address}`),
      ...(envelope.bcc ?? []).map((address) => `bcc:${address}`),
    ];
    const deliveredTo = [...new Set([...to, ...redirectTo])];
    const { cc: _droppedCc, bcc: _droppedBcc, ...rest } = envelope;
    return Object.freeze({
      intercepted: true,
      envelope: Object.freeze({
        ...rest,
        to: Object.freeze(deliveredTo),
        ...(cc.length > 0 ? { cc: Object.freeze(cc) } : {}),
        ...(bcc.length > 0 ? { bcc: Object.freeze(bcc) } : {}),
        subject: prefix ? `[to: ${envelope.to.join(", ")}] ${envelope.subject}` : envelope.subject,
        headers: Object.freeze({
          ...(envelope.headers ?? {}),
          [MAIL_ORIGINAL_TO_HEADER]: original.join(", "),
        }),
      }),
    });
  };

  return Object.freeze({
    kind: "ship.mail-interceptor" as const,
    adapter: "allowlist" as const,
    intercept,
  });
}

function normalize(recipient: string): string {
  const match = /<([^<>\s]+)>\s*$/u.exec(recipient);
  return (match ? (match[1] as string) : recipient).trim().toLowerCase();
}

function assertOptions(options: unknown): asserts options is AllowlistInterceptorOptions {
  if (typeof options !== "object" || options === null) {
    throw new MailInterceptorError("allowlist interceptor options must be an object", "options");
  }
  const allow = Reflect.get(options, "allow");
  if (
    !Array.isArray(allow) ||
    !allow.every(
      (entry) =>
        typeof entry === "string" &&
        (entry.startsWith("@") ? /^@[^\s@]+\.[^\s@]+$/u.test(entry) : isMailAddress(entry)),
    )
  ) {
    throw new MailInterceptorError(
      "allowlist interceptor allow must list email addresses or @domains",
      "allow",
    );
  }
  const redirectTo = Reflect.get(options, "redirectTo");
  if (
    !Array.isArray(redirectTo) ||
    redirectTo.length === 0 ||
    !redirectTo.every((entry) => isMailAddress(entry))
  ) {
    throw new MailInterceptorError(
      "allowlist interceptor redirectTo must list at least one email address",
      "redirectTo",
    );
  }
  const subjectPrefix = Reflect.get(options, "subjectPrefix");
  if (subjectPrefix !== undefined && typeof subjectPrefix !== "boolean") {
    throw new MailInterceptorError(
      "allowlist interceptor subjectPrefix must be a boolean",
      "subjectPrefix",
    );
  }
}
