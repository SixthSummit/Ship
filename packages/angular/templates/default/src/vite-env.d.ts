/// <reference types="vite/client" />

/**
 * Vite-injected env shape augmentation. Add the `import.meta.env` keys you
 * actually use here so they're typed at the read-site.
 *
 * @example
 *   readonly VITE_API_BASE: string;
 *   readonly VITE_FIREBASE_API_KEY: string;
 *   readonly VITE_MSW: 'true' | 'false';
 */
interface ImportMetaEnv {
  readonly VITE_MSW?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
