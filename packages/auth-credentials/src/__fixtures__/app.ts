import {
  authenticatedAccess,
  createExecutor,
  defineApp,
  defineModule,
  defineOperation,
  jobBackendDependency,
  mailLedgerDependency,
  mailProviderDependency,
  type OperationActorInput,
  operationActor,
  permission,
  startJobRuntime,
  valueProvider,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";
import {
  createInMemoryMailLedger,
  defineMailDelivery,
  logMailProvider,
} from "@sixthsummit/ship-mail";
import { createInMemoryJobBackend } from "@sixthsummit/ship-testing/jobs";
import { z } from "zod";
import { createRequestClientRegistry } from "../client.js";
import { type CredentialSessionOptions, credentialSessionCsrfPolicy } from "../cookie.js";
import { argon2idPasswordHasher } from "../crypto/password.js";
import { defineCredentialAuthMailer } from "../mailer.js";
import { createInMemoryCredentialStore, type InMemoryCredentialStore } from "../memory-store.js";
import { defineCredentialAuthModule } from "../module.js";
import type { CredentialAuthPolicyOptions } from "../policy.js";
import { credentialAuthentication, type ResolveCredentialActorRequest } from "../provider.js";
import { credentialAuthRateLimitPolicies } from "../rate-limit.js";
import type { CredentialStore } from "../store.js";

export const KEY_RING = {
  current: "k1",
  keys: { k1: "11".repeat(32), k0: "00".repeat(32) },
};

export const BASE_URL = "https://app.example.test";

export const fixtureMailer = defineCredentialAuthMailer({
  from: "Fixture <auth@example.test>",
  appName: "Fixture App",
});

export interface FixtureOptions {
  readonly policies?: CredentialAuthPolicyOptions;
  readonly defaultRoles?: readonly string[];
  readonly start?: Date;
  readonly rateLimit?: { readonly max: number; readonly windowMs: number };
  readonly resolveActor?: (request: ResolveCredentialActorRequest) => OperationActorInput | null;
  readonly onExistingEmail?: "reject" | "conceal";
  /** `null` omits `links.signIn` to exercise the construction-time diagnostic. */
  readonly signInLink?: string | null;
  /** An external store (the PostgreSQL store in the integration test); defaults to in-memory. */
  readonly store?: CredentialStore;
  /** Session transport configuration; cookie transports also register the CSRF policy under `"*"`. */
  readonly sessions?: CredentialSessionOptions;
  /** Browser origins the CSRF policy trusts beside the request's own origin. */
  readonly trustedOrigins?: readonly string[];
  /** `null` omits the clients registry to exercise the cookie-mode diagnostic. */
  readonly clients?: null;
}

/** The auth module beside a protected application operation and a slow one for the revoke-all race. */
export function createFixture(options: FixtureOptions = {}) {
  let now = options.start ?? new Date("2026-10-23T12:00:00.000Z");
  const clock = () => now;
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const store = (options.store ?? createInMemoryCredentialStore()) as InMemoryCredentialStore;
  const provider = logMailProvider({ clock });
  const ledger = createInMemoryMailLedger();
  const jobs = createInMemoryJobBackend({ clock });
  const clients = createRequestClientRegistry();
  const delivery = defineMailDelivery({ mailers: [fixtureMailer], clock });
  const auth = defineCredentialAuthModule({
    store,
    mailer: fixtureMailer,
    mail: delivery.dependency,
    links: {
      verifyEmail: (token) => `${BASE_URL}/verify/${token}`,
      resetPassword: (token) => `${BASE_URL}/reset/${token}`,
      changeEmail: (token) => `${BASE_URL}/email/${token}`,
      ...(options.signInLink === null
        ? {}
        : { signIn: options.signInLink ?? `${BASE_URL}/sign-in` }),
    },
    secrets: KEY_RING,
    // Cheap argon2id for tests; production uses the default parameters.
    hasher: argon2idPasswordHasher({ memory: 1024, passes: 1 }),
    policies: {
      ...options.policies,
      ...(options.onExistingEmail ? { onExistingEmail: options.onExistingEmail } : {}),
    },
    defaultRoles: options.defaultRoles ?? [],
    ...(options.clients === null ? {} : { clients }),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    clock,
  });
  const mailModule = defineModule({
    id: "mail",
    operations: [delivery.job],
    providers: [
      valueProvider(mailProviderDependency(), provider),
      valueProvider(mailLedgerDependency(), ledger),
      valueProvider(jobBackendDependency(), jobs),
    ],
    imports: [],
    exports: [jobBackendDependency()],
  });
  const gate = { release: () => undefined as void, entered: () => undefined as void };
  const slow = defineOperation({
    id: "app.slow",
    transport: http.post("/app/slow"),
    input: {},
    output: { 200: z.object({ actorId: z.string() }) },
    successStatus: 200,
    errors: [],
    access: authenticatedAccess(),
    transaction: "none",
    dependencies: {},
    handler: async ({ context }) => {
      gate.entered();
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { actorId: context.actor.id };
    },
  });
  const admin = defineOperation({
    id: "app.admin",
    transport: http.get("/app/admin"),
    input: {},
    output: { 200: z.object({ ok: z.literal(true) }) },
    successStatus: 200,
    errors: [],
    access: permission("app:admin"),
    transaction: "none",
    dependencies: {},
    handler: () => ({ ok: true as const }),
  });
  const appModule = defineModule({
    id: "app",
    operations: [slow, admin],
    providers: [],
    imports: [],
    exports: [],
  });
  const app = defineApp({
    id: "auth-fixture",
    modules: [auth, mailModule, appModule],
    runtime: { workers: { mode: "api" } },
  });
  const resolveActor =
    options.resolveActor ??
    (({ account, session }: ResolveCredentialActorRequest) =>
      operationActor({
        id: account.id,
        permissions:
          session.mfaState === "verified" || !account.roles.includes("admin")
            ? account.roles.map((role) => `app:${role}`)
            : [],
      }));
  const authentication = credentialAuthentication({
    store,
    resolveActor,
    clients,
    session: auth.policies.session,
    sessions: auth.sessions,
    clock,
  });
  const preValidationPolicies = {
    ...(auth.sessions.cookie
      ? {
          "*": credentialSessionCsrfPolicy({
            auth,
            ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
          }),
        }
      : {}),
    ...(options.rateLimit ? credentialAuthRateLimitPolicies({ ...options.rateLimit, clock }) : {}),
  };
  const httpApp = createHonoAdapter(app, {
    auth: authentication,
    ...(Object.keys(preValidationPolicies).length > 0 ? { preValidationPolicies } : {}),
  });
  const executor = createExecutor(app);

  const request = async (
    path: string,
    init: {
      readonly method?: string;
      readonly token?: string;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
    } = {},
  ): Promise<{ readonly status: number; readonly body: any; readonly headers: Headers }> => {
    const response = await httpApp.request(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        "x-forwarded-for": "203.0.113.7",
        "user-agent": "fixture/1.0",
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    const body: any = text.length > 0 ? JSON.parse(text) : undefined;
    return { status: response.status, body, headers: response.headers };
  };

  /** Delivers queued mail and returns the links found in every message since the last call. */
  let seen = 0;
  const deliverMail = async () => {
    await jobs.drain();
    const sent = provider.sent().slice(seen);
    seen = provider.sent().length;
    return sent.map((entry) => {
      const url = /https:\/\/\S+/u.exec(entry.envelope.text)?.[0] ?? "";
      return {
        to: entry.envelope.to,
        message: entry.message,
        url,
        token: url.slice(url.lastIndexOf("/") + 1),
      };
    });
  };

  return {
    app,
    auth,
    store,
    provider,
    jobs,
    executor,
    http: httpApp,
    request,
    deliverMail,
    advance,
    clock,
    gate,
    start: async () => {
      await startJobRuntime(app, { backend: jobs, mode: "api" });
    },
  };
}

export type Fixture = ReturnType<typeof createFixture>;

export const EMAIL = "ada@example.test";
export const PASSWORD = "correct horse battery staple";

/** Registers and verifies an account, returning the session from a first sign-in. */
export async function registerAndSignIn(fixture: Fixture, email = EMAIL, password = PASSWORD) {
  const registered = await fixture.request("/auth/register", {
    body: { email, password, name: "Ada" },
  });
  if (registered.status !== 201)
    throw new Error(`register failed: ${JSON.stringify(registered.body)}`);
  const [mail] = await fixture.deliverMail();
  if (!mail?.token) throw new Error("no verification mail");
  const verified = await fixture.request("/auth/verify-email", { body: { token: mail.token } });
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);
  const signedIn = await fixture.request("/auth/sign-in", { body: { email, password } });
  if (signedIn.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(signedIn.body)}`);
  return signedIn.body as {
    status: string;
    session: { token: string; id: string; expiresAt: string; mfaState: string };
    account: { id: string; email: string };
  };
}

/**
 * A minimal cookie jar for the fixture: stores every `Set-Cookie` a response
 * carries (honouring `Max-Age=0` as removal) and renders the `Cookie` header
 * a browser would send back. Attributes are kept for assertions.
 */
export function createCookieJar() {
  const cookies = new Map<string, { value: string; attributes: string }>();
  return {
    absorb(headers: Headers): void {
      for (const line of headers.getSetCookie()) {
        const [pair = "", ...rest] = line.split(";");
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        const attributes = rest.map((part) => part.trim()).join("; ");
        if (/(?:^|; )Max-Age=0(?:;|$)/u.test(attributes) || value.length === 0)
          cookies.delete(name);
        else cookies.set(name, { value, attributes });
      }
    },
    header(): string | undefined {
      if (cookies.size === 0) return undefined;
      return [...cookies].map(([name, cookie]) => `${name}=${cookie.value}`).join("; ");
    },
    get(name: string): { value: string; attributes: string } | undefined {
      return cookies.get(name);
    },
    names(): string[] {
      return [...cookies.keys()];
    },
  };
}
