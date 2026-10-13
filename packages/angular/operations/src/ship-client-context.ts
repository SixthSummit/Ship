import { isPlatformBrowser } from '@angular/common';

export interface ShipClientForwardingRules {
  /** Cookie names approved for forwarding to ShipAPI during SSR. */
  readonly cookieNames?: readonly string[];
  /** Incoming header names approved for forwarding during SSR. */
  readonly headerNames?: readonly string[];
}

export interface ShipClientContextConfig {
  /** Absolute browser/server-safe base URL. Paths such as `/v1` are preserved. */
  readonly apiBaseUrl: string;
  readonly forwarding?: ShipClientForwardingRules;
}

/** Sanitized, request-scoped context supplied to an operation-client factory. */
export interface ShipClientContext {
  readonly platform: 'browser' | 'server';
  readonly apiBaseUrl: string;
  readonly forwardedHeaders: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

const FORBIDDEN_FORWARDED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
]);

/** Build a sanitized browser or SSR call context without exposing the raw request. */
export function createShipClientContext(
  platformId: unknown,
  request: Request | null,
  config: ShipClientContextConfig
): ShipClientContext {
  const platform = isPlatformBrowser(platformId as object) ? 'browser' : 'server';
  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl);
  if (platform === 'browser' || request === null) {
    return {
      platform,
      apiBaseUrl,
      forwardedHeaders: Object.freeze({}),
    };
  }

  const headers: Record<string, string> = {};
  for (const requestedName of config.forwarding?.headerNames ?? []) {
    const name = requestedName.toLowerCase();
    if (FORBIDDEN_FORWARDED_HEADERS.has(name)) {
      throw new Error(`Ship client cannot forward sensitive header: ${name}`);
    }
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  const cookie = selectCookies(request.headers.get('cookie'), config.forwarding?.cookieNames ?? []);
  if (cookie !== undefined) headers['cookie'] = cookie;

  return {
    platform,
    apiBaseUrl,
    forwardedHeaders: Object.freeze(headers),
    signal: request.signal,
  };
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Ship client apiBaseUrl must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Ship client apiBaseUrl must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('Ship client apiBaseUrl must not contain a query or fragment');
  }
  return url.href.endsWith('/') ? url.href.slice(0, -1) : url.href;
}

function selectCookies(source: string | null, allowedNames: readonly string[]): string | undefined {
  if (source === null || allowedNames.length === 0) return undefined;
  const allowed = new Set(
    allowedNames.map(name => {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
        throw new Error('Ship client forwarding contains an invalid cookie name');
      }
      return name;
    })
  );
  const selected = source
    .split(';')
    .map(part => part.trim())
    .filter(part => {
      const separator = part.indexOf('=');
      return separator > 0 && allowed.has(part.slice(0, separator));
    });
  return selected.length > 0 ? selected.join('; ') : undefined;
}
