import type { Response } from 'express';

/**
 * CSP directives → list of source values. Use the literal `__nonce__` token
 * inside a directive's source list to interpolate the per-request nonce; it
 * gets replaced with `'nonce-<base64>'` at request time.
 */
export type CspDirectives = Readonly<Record<string, readonly string[]>>;

/**
 * Configuration for {@link applySecurityHeaders}.
 *
 * Defaults are strict by design — Phase 2 ships ShipAngular templates with
 * an A+ securityheaders.com profile out of the box. Loosening is allowed
 * but should require a documented reason; mark disable sites with an
 * `# unsafe:reason` comment so audits can find them.
 */
export interface SecurityHeadersConfig {
  /** Content-Security-Policy directives. Use `__nonce__` token for nonce slots. */
  csp?: CspDirectives;
  /** Enable Trusted Types policy enforcement (`require-trusted-types-for: 'script'`). */
  trustedTypes?: boolean;
  /** Strict-Transport-Security configuration. Set to `false` to disable (not recommended in prod). */
  hsts?:
    | false
    | {
        maxAge: number;
        includeSubDomains?: boolean;
        preload?: boolean;
      };
  /** `Referrer-Policy` value. */
  referrerPolicy?: string;
  /** Permissions-Policy directives → list of allowed origins (empty = blocked). */
  permissionsPolicy?: Readonly<Record<string, readonly string[]>>;
  /** Whether to set `X-Content-Type-Options: nosniff`. Default: true. */
  noSniff?: boolean;
}

/**
 * Apply the security-headers stack to a response. Called per-request from
 * `server.ts` so the CSP can carry a per-request nonce.
 *
 * Designed to keep `server.ts` lean — adjust the policy here, not at the
 * call site. Disable a header by setting it to `false` (or omitting it
 * from the config).
 *
 * @param res - The Express response to mutate.
 * @param config - The security configuration. See module-level defaults
 *   in `server.ts` for a tuned starting point.
 * @param nonce - The per-request nonce. CSP `__nonce__` slots are replaced.
 */
export function applySecurityHeaders(
  res: Response,
  config: SecurityHeadersConfig,
  nonce: string
): void {
  if (config.csp) {
    res.setHeader('Content-Security-Policy', buildCsp(config.csp, nonce));
  }
  if (config.trustedTypes) {
    res.setHeader('Require-Trusted-Types-For', "'script'");
    // Apps may opt into a specific named policy; default-allow lets
    // Angular's built-in policy work.
    res.setHeader('Trusted-Types', 'angular angular#bundler default');
  }
  if (config.hsts !== false && config.hsts) {
    const parts = [`max-age=${config.hsts.maxAge}`];
    if (config.hsts.includeSubDomains) parts.push('includeSubDomains');
    if (config.hsts.preload) parts.push('preload');
    res.setHeader('Strict-Transport-Security', parts.join('; '));
  }
  if (config.referrerPolicy) {
    res.setHeader('Referrer-Policy', config.referrerPolicy);
  }
  if (config.permissionsPolicy) {
    res.setHeader('Permissions-Policy', buildPermissionsPolicy(config.permissionsPolicy));
  }
  if (config.noSniff !== false) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}

function buildCsp(directives: CspDirectives, nonce: string): string {
  const parts: string[] = [];
  for (const [name, sources] of Object.entries(directives)) {
    const resolved = sources.map(s => (s === '__nonce__' ? `'nonce-${nonce}'` : s));
    if (resolved.length === 0) {
      parts.push(name);
    } else {
      parts.push(`${name} ${resolved.join(' ')}`);
    }
  }
  return parts.join('; ');
}

function buildPermissionsPolicy(directives: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(directives)
    .map(([feature, allowList]) => {
      if (allowList.length === 0) return `${feature}=()`;
      return `${feature}=(${allowList.map(o => (o === 'self' ? 'self' : `"${o}"`)).join(' ')})`;
    })
    .join(', ');
}
