import { randomUUID } from "node:crypto";
import type {
  AuthAccount,
  AuthAccountPatch,
  AuthAuditEvent,
  AuthAuditQuery,
  AuthMfaSecret,
  AuthSession,
  AuthSessionMfaState,
  AuthToken,
  AuthTokenPurpose,
  CreateAccountResult,
  CredentialStore,
} from "./store.js";
import { normalizeEmail } from "./store.js";

interface MutableAccount {
  id: string;
  email: string;
  name?: string;
  status: "active" | "disabled";
  roles: string[];
  emailVerifiedAt?: Date;
  failedAttempts: number;
  lastFailedAt?: Date;
  lockedUntil?: Date;
  sessionsInvalidBefore?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface MutableToken {
  id: string;
  accountId: string;
  purpose: AuthTokenPurpose;
  tokenHash: string;
  payload?: Record<string, string>;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
}

interface MutableSecret {
  accountId: string;
  secretCiphertext: string;
  keyId: string;
  enabledAt?: Date;
  lastUsedStep?: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MutableRecoveryCode {
  id: string;
  accountId: string;
  codeHash: string;
  usedAt?: Date;
  createdAt: Date;
}

interface MutableSession {
  id: string;
  accountId: string;
  tokenHash: string;
  mfaState: AuthSessionMfaState;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
  ip?: string;
  userAgent?: string;
}

export interface InMemoryCredentialStore extends CredentialStore {
  readonly adapter: "memory";
  readonly reset: () => void;
  /** Every audit row, oldest first (tests). */
  readonly auditEvents: () => readonly AuthAuditEvent[];
}

/**
 * Process-local store for unit tests and local development. It implements the
 * same conditional-write semantics as the PostgreSQL store: a token, a
 * recovery code and a TOTP step can be consumed exactly once, and revoking an
 * already revoked session reports false.
 */
export function createInMemoryCredentialStore(): InMemoryCredentialStore {
  let accounts = new Map<string, MutableAccount>();
  let credentials = new Map<string, { passwordHash: string; algorithm: string; updatedAt: Date }>();
  let tokens = new Map<string, MutableToken>();
  let secrets = new Map<string, MutableSecret>();
  let recoveryCodes: MutableRecoveryCode[] = [];
  let sessions = new Map<string, MutableSession>();
  let audit: AuthAuditEvent[] = [];
  const auditSequence = new WeakMap<AuthAuditEvent, number>();

  const liveToken = (input: { tokenHash: string; purpose: AuthTokenPurpose; now: Date }) => {
    const token = [...tokens.values()].find(
      (item) => item.tokenHash === input.tokenHash && item.purpose === input.purpose,
    );
    if (!token || token.consumedAt || token.expiresAt.getTime() <= input.now.getTime()) {
      return undefined;
    }
    return token;
  };
  const emailTaken = (email: string, except?: string) =>
    [...accounts.values()].some((account) => account.email === email && account.id !== except);

  const store: InMemoryCredentialStore = {
    kind: "ship.credential-store",
    adapter: "memory",

    async createAccount(input): Promise<CreateAccountResult> {
      const email = normalizeEmail(input.email);
      if (emailTaken(email)) return { ok: false, reason: "email-taken" };
      const account: MutableAccount = {
        id: randomUUID(),
        email,
        ...(input.name !== undefined ? { name: input.name } : {}),
        status: "active",
        roles: [...input.roles],
        ...(input.emailVerifiedAt ? { emailVerifiedAt: input.emailVerifiedAt } : {}),
        failedAttempts: 0,
        createdAt: input.now,
        updatedAt: input.now,
      };
      accounts.set(account.id, account);
      credentials.set(account.id, {
        passwordHash: input.passwordHash,
        algorithm: input.algorithm,
        updatedAt: input.now,
      });
      return { ok: true, account: accountView(account) };
    },
    async findAccount(id) {
      const account = accounts.get(id);
      return account ? accountView(account) : undefined;
    },
    async findAccountByEmail(email) {
      const normalized = normalizeEmail(email);
      const account = [...accounts.values()].find((item) => item.email === normalized);
      return account ? accountView(account) : undefined;
    },
    async updateAccount(id, patch: AuthAccountPatch, now) {
      const account = accounts.get(id);
      if (!account) return { ok: false, reason: "not-found" };
      if (patch.email !== undefined) {
        const email = normalizeEmail(patch.email);
        if (emailTaken(email, id)) return { ok: false, reason: "email-taken" };
        account.email = email;
      }
      if (patch.name !== undefined) account.name = patch.name ?? undefined;
      if (patch.status !== undefined) account.status = patch.status;
      if (patch.roles !== undefined) account.roles = [...patch.roles];
      if (patch.emailVerifiedAt !== undefined) {
        account.emailVerifiedAt = patch.emailVerifiedAt ?? undefined;
      }
      if (patch.failedAttempts !== undefined) account.failedAttempts = patch.failedAttempts;
      if (patch.lastFailedAt !== undefined) account.lastFailedAt = patch.lastFailedAt ?? undefined;
      if (patch.lockedUntil !== undefined) account.lockedUntil = patch.lockedUntil ?? undefined;
      if (patch.sessionsInvalidBefore !== undefined) {
        account.sessionsInvalidBefore = patch.sessionsInvalidBefore ?? undefined;
      }
      account.updatedAt = now;
      return { ok: true, account: accountView(account) };
    },

    async findCredential(accountId) {
      const credential = credentials.get(accountId);
      return credential ? { accountId, ...credential } : undefined;
    },
    async setCredential(accountId, credential) {
      credentials.set(accountId, {
        passwordHash: credential.passwordHash,
        algorithm: credential.algorithm,
        updatedAt: credential.now,
      });
    },

    async createToken(input) {
      const token: MutableToken = {
        id: randomUUID(),
        accountId: input.accountId,
        purpose: input.purpose,
        tokenHash: input.tokenHash,
        ...(input.payload ? { payload: { ...input.payload } } : {}),
        expiresAt: input.expiresAt,
        createdAt: input.now,
      };
      tokens.set(token.id, token);
      return tokenView(token);
    },
    async findToken(input) {
      const token = liveToken(input);
      return token ? tokenView(token) : undefined;
    },
    async consumeToken(input) {
      const token = liveToken(input);
      if (!token) return undefined;
      token.consumedAt = input.now;
      return tokenView(token);
    },
    async revokeTokens(input) {
      let revoked = 0;
      for (const token of tokens.values()) {
        if (
          token.accountId === input.accountId &&
          token.purpose === input.purpose &&
          !token.consumedAt &&
          token.expiresAt.getTime() > input.now.getTime()
        ) {
          token.consumedAt = input.now;
          revoked += 1;
        }
      }
      return revoked;
    },

    async findMfaSecret(accountId) {
      const secret = secrets.get(accountId);
      return secret ? secretView(secret) : undefined;
    },
    async upsertMfaSecret(input) {
      const existing = secrets.get(input.accountId);
      const secret: MutableSecret = {
        accountId: input.accountId,
        secretCiphertext: input.secretCiphertext,
        keyId: input.keyId,
        ...(input.enabledAt ? { enabledAt: input.enabledAt } : {}),
        ...(existing?.lastUsedStep !== undefined ? { lastUsedStep: existing.lastUsedStep } : {}),
        createdAt: existing?.createdAt ?? input.now,
        updatedAt: input.now,
      };
      secrets.set(input.accountId, secret);
      return secretView(secret);
    },
    async claimMfaStep(accountId, step, now) {
      const secret = secrets.get(accountId);
      if (!secret || (secret.lastUsedStep !== undefined && secret.lastUsedStep >= step)) {
        return false;
      }
      secret.lastUsedStep = step;
      secret.updatedAt = now;
      return true;
    },
    async deleteMfaSecret(accountId) {
      secrets.delete(accountId);
    },

    async replaceRecoveryCodes(accountId, codeHashes, now) {
      recoveryCodes = recoveryCodes.filter((code) => code.accountId !== accountId);
      for (const codeHash of codeHashes) {
        recoveryCodes.push({ id: randomUUID(), accountId, codeHash, createdAt: now });
      }
    },
    async consumeRecoveryCode(input) {
      const code = recoveryCodes.find(
        (item) =>
          item.accountId === input.accountId && item.codeHash === input.codeHash && !item.usedAt,
      );
      if (!code) return false;
      code.usedAt = input.now;
      return true;
    },
    async countRecoveryCodes(accountId) {
      const mine = recoveryCodes.filter((code) => code.accountId === accountId);
      const used = mine.filter((code) => code.usedAt).length;
      return { remaining: mine.length - used, used };
    },

    async createSession(input) {
      const session: MutableSession = {
        id: randomUUID(),
        accountId: input.accountId,
        tokenHash: input.tokenHash,
        mfaState: input.mfaState,
        createdAt: input.now,
        expiresAt: input.expiresAt,
        lastSeenAt: input.now,
        ...(input.ip !== undefined ? { ip: input.ip } : {}),
        ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      };
      sessions.set(session.id, session);
      return sessionView(session);
    },
    async findSession(id) {
      const session = sessions.get(id);
      return session ? sessionView(session) : undefined;
    },
    async findSessionByTokenHash(tokenHash) {
      const session = [...sessions.values()].find((item) => item.tokenHash === tokenHash);
      return session ? sessionView(session) : undefined;
    },
    async listSessions(accountId, options = {}) {
      return Object.freeze(
        [...sessions.values()]
          .filter(
            (session) =>
              session.accountId === accountId && (options.includeRevoked || !session.revokedAt),
          )
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map(sessionView),
      );
    },
    async touchSession(id, now) {
      const session = sessions.get(id);
      if (session) session.lastSeenAt = now;
    },
    async updateSession(id, patch) {
      const session = sessions.get(id);
      if (!session) return undefined;
      if (patch.mfaState !== undefined) session.mfaState = patch.mfaState;
      if (patch.expiresAt !== undefined) session.expiresAt = patch.expiresAt;
      return sessionView(session);
    },
    async revokeSession(id, revocation) {
      const session = sessions.get(id);
      if (!session || session.revokedAt) return false;
      session.revokedAt = revocation.now;
      session.revokedReason = revocation.reason;
      return true;
    },
    async revokeSessions(accountId, revocation) {
      let revoked = 0;
      for (const session of sessions.values()) {
        if (
          session.accountId === accountId &&
          !session.revokedAt &&
          session.id !== revocation.except
        ) {
          session.revokedAt = revocation.now;
          session.revokedReason = revocation.reason;
          revoked += 1;
        }
      }
      return revoked;
    },

    async recordAudit(event) {
      const record: AuthAuditEvent = Object.freeze({ id: randomUUID(), ...event });
      auditSequence.set(record, audit.length);
      audit.push(record);
      return record;
    },
    async listAudit(query: AuthAuditQuery) {
      return Object.freeze(
        [...audit]
          .filter(
            (event) =>
              (query.accountId === undefined || event.accountId === query.accountId) &&
              (query.event === undefined || event.event === query.event) &&
              (query.outcome === undefined || event.outcome === query.outcome) &&
              (query.before === undefined || event.createdAt.getTime() < query.before.getTime()),
          )
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() ||
              (auditSequence.get(right) ?? 0) - (auditSequence.get(left) ?? 0),
          )
          .slice(0, query.limit),
      );
    },

    async cleanup({ before }) {
      let deletedTokens = 0;
      for (const [id, token] of tokens) {
        const dead =
          token.consumedAt ??
          (token.expiresAt.getTime() <= before.getTime() ? token.expiresAt : undefined);
        if (dead && dead.getTime() < before.getTime()) {
          tokens.delete(id);
          deletedTokens += 1;
        }
      }
      let deletedSessions = 0;
      for (const [id, session] of sessions) {
        const dead =
          session.revokedAt ??
          (session.expiresAt.getTime() <= before.getTime() ? session.expiresAt : undefined);
        if (dead && dead.getTime() < before.getTime()) {
          sessions.delete(id);
          deletedSessions += 1;
        }
      }
      return { tokens: deletedTokens, sessions: deletedSessions };
    },

    reset: () => {
      accounts = new Map();
      credentials = new Map();
      tokens = new Map();
      secrets = new Map();
      recoveryCodes = [];
      sessions = new Map();
      audit = [];
    },
    auditEvents: () => Object.freeze([...audit]),
  };
  return Object.freeze(store);
}

function accountView(account: MutableAccount): AuthAccount {
  return Object.freeze({
    id: account.id,
    email: account.email,
    ...(account.name !== undefined ? { name: account.name } : {}),
    status: account.status,
    roles: Object.freeze([...account.roles]),
    ...(account.emailVerifiedAt ? { emailVerifiedAt: account.emailVerifiedAt } : {}),
    failedAttempts: account.failedAttempts,
    ...(account.lastFailedAt ? { lastFailedAt: account.lastFailedAt } : {}),
    ...(account.lockedUntil ? { lockedUntil: account.lockedUntil } : {}),
    ...(account.sessionsInvalidBefore
      ? { sessionsInvalidBefore: account.sessionsInvalidBefore }
      : {}),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  });
}

function tokenView(token: MutableToken): AuthToken {
  return Object.freeze({
    id: token.id,
    accountId: token.accountId,
    purpose: token.purpose,
    tokenHash: token.tokenHash,
    ...(token.payload ? { payload: Object.freeze({ ...token.payload }) } : {}),
    expiresAt: token.expiresAt,
    ...(token.consumedAt ? { consumedAt: token.consumedAt } : {}),
    createdAt: token.createdAt,
  });
}

function secretView(secret: MutableSecret): AuthMfaSecret {
  return Object.freeze({
    accountId: secret.accountId,
    secretCiphertext: secret.secretCiphertext,
    keyId: secret.keyId,
    ...(secret.enabledAt ? { enabledAt: secret.enabledAt } : {}),
    ...(secret.lastUsedStep !== undefined ? { lastUsedStep: secret.lastUsedStep } : {}),
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  });
}

function sessionView(session: MutableSession): AuthSession {
  return Object.freeze({
    id: session.id,
    accountId: session.accountId,
    tokenHash: session.tokenHash,
    mfaState: session.mfaState,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
    ...(session.revokedReason !== undefined ? { revokedReason: session.revokedReason } : {}),
    ...(session.ip !== undefined ? { ip: session.ip } : {}),
    ...(session.userAgent !== undefined ? { userAgent: session.userAgent } : {}),
  });
}
