import type { CookieCredentialCapability } from '@sixthsummit/ship-angular/operations';

/** How the session travels between the browser and the API. */
export type CredentialSessionTransport = 'bearer' | 'cookie';

/** Where the session bearer lives between page loads, or that there is none to keep. */
export interface ShipCredentialSessionStorage {
  /**
   * `bearer` keeps the token on the client and presents it as
   * `Authorization: Bearer`; `cookie` never sees the token, which travels in
   * the `httpOnly` cookie the server set. Absent means `bearer` (an older
   * custom storage).
   */
  readonly transport?: CredentialSessionTransport;
  read(): string | null;
  write(token: string | null): void;
}

/** Keeps the bearer in memory only: a reload signs the person out. */
export function memorySessionStorage(): ShipCredentialSessionStorage {
  let current: string | null = null;
  return {
    transport: 'bearer',
    read: () => current,
    write: token => {
      current = token;
    },
  };
}

/**
 * Keeps the bearer in `localStorage` under `key`. Every access is guarded, so
 * a private window or blocked storage degrades to the memory behaviour. Any
 * injected script can read it; prefer {@link cookieSessionStorage} in a browser.
 */
export function browserSessionStorage(
  key = 'ship.credential-session'
): ShipCredentialSessionStorage {
  const fallback = memorySessionStorage();
  const storage = (): Storage | undefined => {
    try {
      return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
    } catch {
      return undefined;
    }
  };
  return {
    transport: 'bearer',
    read: () => {
      try {
        return storage()?.getItem(key) ?? fallback.read();
      } catch {
        return fallback.read();
      }
    },
    write: token => {
      fallback.write(token);
      try {
        if (token === null) storage()?.removeItem(key);
        else storage()?.setItem(key, token);
      } catch {
        // Memory already holds it.
      }
    },
  };
}

export interface CookieSessionOptions {
  /** The readable CSRF cookie the server sets. Defaults to `ship_csrf` (the module default). */
  readonly csrfCookieName?: string;
  /** The header the token is echoed in. Defaults to `x-csrf-token` (the module default). */
  readonly csrfHeaderName?: string;
}

/** The storage {@link cookieSessionStorage} returns: nothing to keep, plus the CSRF capability. */
export interface ShipCookieSessionStorage extends ShipCredentialSessionStorage {
  readonly transport: 'cookie';
  readonly csrfCookieName: string;
  readonly csrfHeaderName: string;
  /** The current CSRF token from `document.cookie`, or `null` (SSR, or before the first response). */
  readCsrfToken(): string | null;
  /** The `kind: 'cookie'` capability for the application's policy client. */
  credential<TContract extends object>(): CookieCredentialCapability<TContract>;
}

/**
 * The browser default: the session lives in the server's `httpOnly` cookie,
 * so no token is ever held in JavaScript and a reload keeps the person
 * signed in. Sign-in asks the server for the cookie transport; the CSRF
 * cookie the server sets alongside it is echoed in the CSRF header by the
 * operation client's cookie credential capability ({@link ShipCookieSessionStorage.credential}).
 */
export function cookieSessionStorage(options: CookieSessionOptions = {}): ShipCookieSessionStorage {
  const csrfCookieName = options.csrfCookieName ?? 'ship_csrf';
  const csrfHeaderName = (options.csrfHeaderName ?? 'x-csrf-token').toLowerCase();
  return {
    transport: 'cookie',
    csrfCookieName,
    csrfHeaderName,
    read: () => null,
    write: () => undefined,
    readCsrfToken: () => readBrowserCookie(csrfCookieName),
    credential: <TContract extends object>() =>
      cookieCredentialCapability<TContract>({ csrfCookieName, csrfHeaderName }),
  };
}

/**
 * The `kind: 'cookie'` credential capability for `createPolicyClient`: sends
 * `credentials: 'include'`, reads the CSRF cookie and attaches it to every
 * operation whose policy declares `csrf: true`. Never touches the session
 * token, which the browser keeps out of script's reach.
 */
export function cookieCredentialCapability<TContract extends object>(
  options: CookieSessionOptions = {}
): CookieCredentialCapability<TContract> {
  const csrfCookieName = options.csrfCookieName ?? 'ship_csrf';
  return {
    kind: 'cookie',
    credentials: 'include',
    csrfHeaderName: (options.csrfHeaderName ?? 'x-csrf-token').toLowerCase(),
    getCsrfToken: async () => readBrowserCookie(csrfCookieName),
  };
}

/** One cookie out of `document.cookie`; `null` without a document (SSR) or when absent. */
export function readBrowserCookie(name: string): string | null {
  let raw: string;
  try {
    if (typeof document === 'undefined') return null;
    raw = document.cookie;
  } catch {
    return null;
  }
  for (const pair of raw.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }
  return null;
}
