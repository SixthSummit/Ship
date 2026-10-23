import type { AnyMailer, DependencyToken } from "@sixthsummit/ship-core";
import { defineModule, isMailer, valueProvider } from "@sixthsummit/ship-core";
import type { MailSender } from "@sixthsummit/ship-mail";
import type { RequestClientRegistry } from "./client.js";
import { type CredentialSessionOptions, resolveSessionPolicy } from "./cookie.js";
import { argon2idPasswordHasher, type PasswordHasher } from "./crypto/password.js";
import { createSecretBox, type SecretKeyRing } from "./crypto/secretbox.js";
import { InvalidCredentialAuthDefinitionError } from "./errors.js";
import type { CredentialAuthMailer } from "./mailer.js";
import { defineAccountOperations } from "./operations/account.js";
import { defineMfaOperations } from "./operations/mfa.js";
import { definePasswordOperations } from "./operations/password.js";
import { defineSessionOperations } from "./operations/session.js";
import { type CredentialAuthPolicyOptions, resolvePolicies } from "./policy.js";
import type { CredentialAuthLinks, CredentialAuthRuntime } from "./runtime.js";
import { type CredentialStore, credentialStoreDependency, isCredentialStore } from "./store.js";

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const BASE_PATH_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;

export const DEFAULT_CREDENTIAL_AUTH_MODULE_ID = "auth";
export const DEFAULT_CREDENTIAL_AUTH_BASE_PATH = "/auth";

export interface CredentialAuthModuleOptions<
  TId extends string = typeof DEFAULT_CREDENTIAL_AUTH_MODULE_ID,
> {
  /** Module id and operation id prefix. Defaults to `auth`. */
  readonly id?: TId;
  /** HTTP path every flow is mounted under. Defaults to `/auth`. */
  readonly basePath?: string;
  readonly store: CredentialStore;
  /** The `defineCredentialAuthMailer()` result, also registered with the mail delivery. */
  readonly mailer: CredentialAuthMailer;
  /** `delivery.dependency` from `defineMailDelivery({ mailers: [mailer, ...] })`. */
  readonly mail: DependencyToken<unknown, MailSender<readonly AnyMailer[]>>;
  /**
   * Modules this one imports: the one exporting the job backend the mail
   * sender enqueues through (`jobBackendDependency()`), and the one composing
   * the `mail.deliver` job if different. Defaults to `["mail"]`.
   */
  readonly imports?: readonly string[];
  /** Builds the single-use links the mails carry from a token. */
  readonly links: CredentialAuthLinks;
  /** Keys that seal TOTP secrets at rest. */
  readonly secrets: SecretKeyRing;
  readonly policies?: CredentialAuthPolicyOptions;
  /**
   * Session transport: bearer tokens in the body (the default), an
   * `httpOnly` session cookie, or both. Cookie mode requires `clients`,
   * shared with `credentialAuthentication()`, so an operation on the current
   * session knows which transport authenticated the request, and the
   * `credentialSessionCsrfPolicy()` registered under the adapter's `"*"`
   * pre-validation key.
   */
  readonly sessions?: CredentialSessionOptions;
  /** Defaults to argon2id from `node:crypto` (`argon2idPasswordHasher()`). */
  readonly hasher?: PasswordHasher;
  /** Roles stamped on every registered account. Defaults to `[]`. */
  readonly defaultRoles?: readonly string[];
  /** Share with `credentialAuthentication()` so sessions and audit rows carry ip and user agent. */
  readonly clients?: RequestClientRegistry;
  readonly clock?: () => Date;
}

/**
 * Composes every credential flow as declared operations on one module. The
 * module declares the mailer, provides and exports the store token (so the
 * console extension and application modules can bind it) and imports the
 * modules that export the job backend behind the typed mail sender.
 */
export function defineCredentialAuthModule<
  const TId extends string = typeof DEFAULT_CREDENTIAL_AUTH_MODULE_ID,
>(options: CredentialAuthModuleOptions<TId>) {
  assertOptions(options);
  const id = (options.id ?? DEFAULT_CREDENTIAL_AUTH_MODULE_ID) as TId;
  const basePath = options.basePath ?? DEFAULT_CREDENTIAL_AUTH_BASE_PATH;
  const hasher = options.hasher ?? argon2idPasswordHasher();
  const appName = options.mailer.messages.verifyEmail.sample?.appName ?? id;
  const sessions = resolveSessionPolicy(options.sessions);
  if (sessions.cookie && options.clients === undefined) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      'credential auth sessions.transport "cookie" or "both" requires clients (createRequestClientRegistry(), shared with credentialAuthentication()) so sign-out, revoke and MFA confirmation know whether the request authenticated through the cookie',
      { field: "clients" },
    );
  }
  const runtime: CredentialAuthRuntime = {
    id,
    basePath,
    store: credentialStoreDependency(),
    mail: options.mail,
    mailer: options.mailer,
    appName,
    links: options.links,
    policies: resolvePolicies(options.policies, appName),
    sessions,
    hasher,
    secrets: createSecretBox(options.secrets),
    defaultRoles: Object.freeze([...(options.defaultRoles ?? [])]),
    clients: options.clients,
    clock: options.clock ?? (() => new Date()),
    decoyHash: hasher.hash("ship-credentials-decoy-password"),
  };
  const account = defineAccountOperations(id, runtime);
  const session = defineSessionOperations(id, runtime);
  const password = definePasswordOperations(id, runtime);
  const mfa = defineMfaOperations(id, runtime);
  const operations = [
    account.register,
    account.verifyEmail,
    account.resendVerification,
    session.signIn,
    session.signOut,
    session.me,
    session.listSessions,
    session.revokeSession,
    session.revokeAllSessions,
    password.forgotPassword,
    password.resetPassword,
    password.changeEmail,
    password.confirmEmailChange,
    mfa.enrol,
    mfa.confirm,
    mfa.verify,
    mfa.recover,
  ] as const;
  const module = defineModule({
    id,
    operations,
    providers: [valueProvider(runtime.store, options.store)],
    imports: [...(options.imports ?? ["mail"])],
    exports: [runtime.store],
    mailers: [options.mailer],
  });
  return Object.freeze({
    ...module,
    basePath,
    policies: runtime.policies,
    /** The resolved session transports and cookie attributes; pass to `credentialAuthentication({ sessions })` and `credentialSessionCsrfPolicy({ auth })`. */
    sessions: runtime.sessions,
    /** Bind this token (after importing the module) to read accounts, sessions and audit rows. */
    store: runtime.store,
    flows: Object.freeze({ ...account, ...session, ...password, ...mfa }),
  });
}

export type CredentialAuthModule<TId extends string = typeof DEFAULT_CREDENTIAL_AUTH_MODULE_ID> =
  ReturnType<typeof defineCredentialAuthModule<TId>>;

function assertOptions(options: unknown): asserts options is CredentialAuthModuleOptions {
  if (typeof options !== "object" || options === null) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      "defineCredentialAuthModule options must be an object",
    );
  }
  const id = Reflect.get(options, "id");
  if (id !== undefined && (typeof id !== "string" || !MODULE_ID_PATTERN.test(id))) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      `credential auth module id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
      { field: "id" },
    );
  }
  const basePath = Reflect.get(options, "basePath");
  if (
    basePath !== undefined &&
    (typeof basePath !== "string" || !BASE_PATH_PATTERN.test(basePath))
  ) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      `credential auth basePath must be an absolute path without a trailing slash; received ${JSON.stringify(basePath)}`,
      { field: "basePath" },
    );
  }
  if (!isCredentialStore(Reflect.get(options, "store"))) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_STORE_INVALID",
      "credential auth store must be a CredentialStore (createInMemoryCredentialStore() or the Drizzle store)",
      { field: "store" },
    );
  }
  const mailer = Reflect.get(options, "mailer");
  const moduleId = typeof id === "string" ? id : DEFAULT_CREDENTIAL_AUTH_MODULE_ID;
  if (
    !isMailer(mailer) ||
    !["verifyEmail", "resetPassword", "changeEmail"].every((name) => name in mailer.messages)
  ) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_MAILER_INVALID",
      "credential auth mailer must be a defineCredentialAuthMailer() result",
      { field: "mailer" },
    );
  }
  if (!mailer.id.startsWith(`${moduleId}.`)) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_MAILER_INVALID",
      `credential auth mailer id ${JSON.stringify(mailer.id)} must be namespaced by the module id ${JSON.stringify(moduleId)}`,
      { field: "mailer" },
    );
  }
  const mail = Reflect.get(options, "mail");
  if (
    typeof mail !== "object" ||
    mail === null ||
    Reflect.get(mail, "kind") !== "ship.dependency"
  ) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      "credential auth mail must be the delivery.dependency token from defineMailDelivery()",
      { field: "mail" },
    );
  }
  const links = Reflect.get(options, "links");
  if (
    typeof links !== "object" ||
    links === null ||
    !["verifyEmail", "resetPassword", "changeEmail"].every(
      (name) => typeof Reflect.get(links, name) === "function",
    )
  ) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      "credential auth links must provide verifyEmail, resetPassword and changeEmail builders",
      { field: "links" },
    );
  }
  const policies = Reflect.get(options, "policies");
  const onExistingEmail =
    typeof policies === "object" && policies !== null
      ? Reflect.get(policies, "onExistingEmail")
      : undefined;
  const signIn = Reflect.get(links, "signIn");
  if (onExistingEmail !== "reject" && (typeof signIn !== "string" || !isHttpUrl(signIn))) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      'credential auth links.signIn must be an absolute http(s) URL while policies.onExistingEmail is "conceal" (the default): the existing-account notice links to it. Set policies.onExistingEmail to "reject" to opt out.',
      { field: "links" },
    );
  }
  const hasher = Reflect.get(options, "hasher");
  if (
    hasher !== undefined &&
    (typeof hasher !== "object" ||
      hasher === null ||
      typeof Reflect.get(hasher, "hash") !== "function" ||
      typeof Reflect.get(hasher, "verify") !== "function" ||
      typeof Reflect.get(hasher, "needsRehash") !== "function")
  ) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      "credential auth hasher must implement hash, verify and needsRehash",
      { field: "hasher" },
    );
  }
  const imports = Reflect.get(options, "imports");
  if (
    imports !== undefined &&
    (!Array.isArray(imports) || imports.some((item) => typeof item !== "string"))
  ) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      "credential auth imports must be an array of module ids",
      { field: "imports" },
    );
  }
  const roles = Reflect.get(options, "defaultRoles");
  if (
    roles !== undefined &&
    (!Array.isArray(roles) || roles.some((role) => typeof role !== "string"))
  ) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      "credential auth defaultRoles must be an array of strings",
      { field: "defaultRoles" },
    );
  }
  const clock = Reflect.get(options, "clock");
  if (clock !== undefined && typeof clock !== "function") {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_OPTIONS_INVALID",
      "credential auth clock must be a function",
      { field: "clock" },
    );
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
