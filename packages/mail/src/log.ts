import type { MailProvider, MailProviderOutcome, MailSendRequest } from "@sixthsummit/ship-core";

export interface LoggedMail extends MailSendRequest {
  readonly providerMessageId: string;
  readonly at: Date;
}

export interface LogMailProviderOptions {
  /** Receives every accepted send; wire it to the application logger in development. */
  readonly sink?: (entry: LoggedMail) => void;
  /** Decide the outcome per request; defaults to accepting everything. */
  readonly outcome?: (request: MailSendRequest) => MailProviderOutcome;
  readonly clock?: () => Date;
}

export interface LogMailProvider extends MailProvider {
  readonly adapter: "log";
  /** Every accepted send, oldest first. */
  readonly sent: () => readonly LoggedMail[];
  readonly reset: () => void;
}

/**
 * Development and test provider: records each accepted envelope in memory and
 * hands it to `sink`. It never contacts a network. Pass `outcome` to simulate
 * provider rejections and retryable failures in tests.
 */
export function logMailProvider(options: LogMailProviderOptions = {}): LogMailProvider {
  const clock = options.clock ?? (() => new Date());
  let entries: LoggedMail[] = [];
  let sequence = 0;
  return Object.freeze({
    kind: "ship.mail-provider" as const,
    adapter: "log" as const,
    send: async (request: MailSendRequest): Promise<MailProviderOutcome> => {
      const decided = options.outcome?.(request) ?? { accepted: true as const };
      if (!decided.accepted) return decided;
      sequence += 1;
      const entry: LoggedMail = Object.freeze({
        envelope: request.envelope,
        idempotencyKey: request.idempotencyKey,
        mailerId: request.mailerId,
        message: request.message,
        providerMessageId: decided.providerMessageId ?? `log-${sequence}`,
        at: clock(),
      });
      entries.push(entry);
      options.sink?.(entry);
      return Object.freeze({ accepted: true as const, providerMessageId: entry.providerMessageId });
    },
    sent: () => Object.freeze([...entries]),
    reset: () => {
      entries = [];
      sequence = 0;
    },
  });
}
