import type { MailProvider, MailProviderOutcome, MailSendRequest } from "@sixthsummit/ship-core";

export const RESEND_API_URL = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface ResendMailProviderOptions {
  /** The Resend API key; a credential, never logged or echoed in outcomes. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class ResendMailProviderError extends Error {
  readonly code = "SHIP_MAIL_RESEND_OPTIONS_INVALID";
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ResendMailProviderError";
    this.field = field;
  }
}

/**
 * Resend adapter over `POST /emails`. The send's idempotency key is forwarded
 * as Resend's `Idempotency-Key` header, so a repeated delivery attempt for the
 * same key is deduplicated by the provider as well as by the ledger.
 * Rate limits, timeouts, network errors and 5xx answers are retryable; any
 * other 4xx is a final rejection carrying Resend's message, never the key.
 */
export function resendMailProvider(options: ResendMailProviderOptions): MailProvider {
  assertOptions(options);
  const baseUrl = (options.baseUrl ?? RESEND_API_URL).replace(/\/+$/u, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey;

  const send = async (request: MailSendRequest): Promise<MailProviderOutcome> => {
    const { envelope } = request;
    const body = {
      from: envelope.from,
      to: [...envelope.to],
      ...(envelope.cc && envelope.cc.length > 0 ? { cc: [...envelope.cc] } : {}),
      ...(envelope.bcc && envelope.bcc.length > 0 ? { bcc: [...envelope.bcc] } : {}),
      ...(envelope.replyTo !== undefined ? { reply_to: envelope.replyTo } : {}),
      subject: envelope.subject,
      html: envelope.html,
      text: envelope.text,
      ...(envelope.headers && Object.keys(envelope.headers).length > 0
        ? { headers: { ...envelope.headers } }
        : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": request.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      return Object.freeze({
        accepted: false as const,
        retryable: true,
        error: controller.signal.aborted
          ? `resend request timed out after ${timeoutMs} ms`
          : `resend request failed: ${describe(error)}`,
      });
    }
    clearTimeout(timer);
    const payload = await readJson(response);
    if (response.ok) {
      const id = typeof payload === "object" && payload !== null ? Reflect.get(payload, "id") : undefined;
      return Object.freeze({
        accepted: true as const,
        ...(typeof id === "string" && id.length > 0 ? { providerMessageId: id } : {}),
      });
    }
    const message =
      typeof payload === "object" && payload !== null && typeof Reflect.get(payload, "message") === "string"
        ? (Reflect.get(payload, "message") as string)
        : `resend answered ${response.status}`;
    return Object.freeze({
      accepted: false as const,
      retryable: RETRYABLE_STATUSES.has(response.status),
      error: message,
      status: response.status,
    });
  };

  return Object.freeze({ kind: "ship.mail-provider" as const, adapter: "resend" as const, send });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertOptions(options: unknown): asserts options is ResendMailProviderOptions {
  if (typeof options !== "object" || options === null) {
    throw new ResendMailProviderError("resend provider options must be an object", "options");
  }
  const apiKey = Reflect.get(options, "apiKey");
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new ResendMailProviderError("resend provider apiKey must be a non-empty string", "apiKey");
  }
  const baseUrl = Reflect.get(options, "baseUrl");
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || !/^https:\/\//u.test(baseUrl))) {
    throw new ResendMailProviderError("resend provider baseUrl must be an https URL", "baseUrl");
  }
  const fetchImplementation = Reflect.get(options, "fetch");
  if (fetchImplementation !== undefined && typeof fetchImplementation !== "function") {
    throw new ResendMailProviderError("resend provider fetch must be a function", "fetch");
  }
  const timeoutMs = Reflect.get(options, "timeoutMs");
  if (timeoutMs !== undefined && !(typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs > 0)) {
    throw new ResendMailProviderError("resend provider timeoutMs must be a positive integer", "timeoutMs");
  }
}
