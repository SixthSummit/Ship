/** Where the session bearer lives between page loads. */
export interface ShipCredentialSessionStorage {
  read(): string | null;
  write(token: string | null): void;
}

/** Keeps the bearer in memory only: a reload signs the person out. */
export function memorySessionStorage(): ShipCredentialSessionStorage {
  let current: string | null = null;
  return {
    read: () => current,
    write: token => {
      current = token;
    },
  };
}

/**
 * Keeps the bearer in `localStorage` under `key`. Every access is guarded, so
 * a private window or blocked storage degrades to the memory behaviour.
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
