/**
 * `publicSuffix` — defensive eTLD table for cookie-domain validation.
 *
 * A *public suffix* (also called eTLD — "effective TLD") is the level
 * at which independent organizations register subdomains. Setting a
 * cookie `Domain` attribute on a public suffix leaks the cookie to
 * every site registered under that suffix; browsers SHOULD reject it
 * but historically did not, and tools / WAFs that proxy cookies don't
 * always honor the rule.
 *
 * The defense is simple: refuse to set a cookie whose `domain`
 * attribute *is* a known public suffix. `domain: ".com"` rejects;
 * `domain: ".example.com"` accepts.
 *
 * Coverage in this table is **conservative**: it lists the gTLDs and
 * common country-code patterns that real consumer apps interact with.
 * It is not the full Mozilla PSL — that's ~10 000 entries and ships
 * via `tldts` for adopters who want full coverage. Swapping in `tldts`
 * is a one-commit follow-up under P1/P2 if maintenance proves painful.
 * Exotic country TLDs not in this table receive permissive treatment
 * (accepted) — the framework default of "no `domain` attribute set"
 * remains the right secure default, and this validator only fires
 * when the consumer explicitly overrides.
 */

const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // ─── gTLDs (single label) ────────────────────────────────────────
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "mil",
  "int",
  "info",
  "biz",
  "name",
  "pro",
  "cc",
  "io",
  "dev",
  "ai",
  "co",
  "app",
  "me",
  "tv",
  "xyz",
  "tech",
  "online",
  "store",
  "shop",
  "site",
  "top",
  "live",
  "world",
  "today",
  "news",
  "social",
  "digital",
  "cloud",
  "link",
  "ly",
  "to",
  "nu",
  "tk",
  "team",
  "studio",
  "design",
  "page",
  "blog",
  "host",
  "space",
  "fun",
  "agency",
  "club",

  // ─── ccTLDs (single label, 2 letters — the common ones) ─────────
  "us",
  "uk",
  "ca",
  "au",
  "nz",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "pl",
  "ru",
  "jp",
  "cn",
  "kr",
  "hk",
  "tw",
  "sg",
  "my",
  "th",
  "vn",
  "ph",
  "id",
  "in",
  "br",
  "mx",
  "ar",
  "cl",
  "pe",
  "za",
  "ng",
  "eg",
  "sa",
  "ae",
  "il",
  "tr",
  "gr",
  "pt",
  "ie",
  "dk",
  "no",
  "se",
  "fi",
  "ch",
  "at",
  "be",
  "cz",
  "hu",
  "ro",
  "ua",
  "bg",
  "sk",
  "si",
  "hr",
  "lt",
  "lv",
  "ee",
  "is",
  "lu",
  "mt",
  "cy",
  "li",
  "md",
  "by",
  "rs",
  "ba",
  "mk",
  "al",
  "ge",
  "am",
  "az",
  "kz",
  "uz",
  "kg",
  "ke",
  "tz",
  "ug",
  "zw",
  "ma",
  "tn",
  "dz",

  // ─── Multi-label eTLDs (common public-registration patterns) ────
  "co.uk",
  "co.jp",
  "co.kr",
  "co.nz",
  "co.za",
  "co.in",
  "co.id",
  "co.il",
  "co.th",
  "co.ma",
  "co.ke",
  "co.ug",
  "co.zw",
  "co.tz",
  "com.au",
  "com.br",
  "com.mx",
  "com.ar",
  "com.cn",
  "com.hk",
  "com.sg",
  "com.my",
  "com.ph",
  "com.vn",
  "com.tr",
  "com.tw",
  "com.pl",
  "com.ua",
  "com.ru",
  "com.sa",
  "com.ng",
  "com.eg",
  "com.pe",
  "com.ec",
  "com.uy",
  "com.bo",
  "com.py",
  "com.gt",
  "com.es",
  "com.fr",
  "ac.uk",
  "gov.uk",
  "org.uk",
  "net.uk",
  "sch.uk",
  "mod.uk",
  "plc.uk",
  "ltd.uk",
  "me.uk",
  "ne.jp",
  "or.jp",
  "ad.jp",
  "ac.jp",
  "gov.jp",
  "lg.jp",
  "go.jp",
  "gov.au",
  "edu.au",
  "org.au",
  "asn.au",
  "id.au",
  "net.au",
  "ac.nz",
  "co.nz",
  "gen.nz",
  "geek.nz",
  "kiwi.nz",
  "maori.nz",
  "net.nz",
  "org.nz",
  "school.nz",
  "edu.cn",
  "gov.cn",
  "net.cn",
  "org.cn",
  "ac.cn",
  "edu.hk",
  "gov.hk",
  "net.hk",
  "org.hk",
  "idv.hk",
]);

/**
 * Test whether a cookie-domain configuration value would leak the
 * cookie to every site under a public suffix. Returns `null` when
 * the value is safe (or empty), otherwise an explanatory string the
 * caller folds into the thrown error message.
 */
export function checkCookieDomainAgainstPublicSuffix(domain: string | undefined): string | null {
  if (domain == null) return null;
  const trimmed = domain.trim();
  if (trimmed.length === 0) return null;

  // Strip a single leading dot — `.example.com` and `example.com`
  // mean the same thing to modern browsers (the leading-dot syntax is
  // legacy compatibility).
  const noLeadingDot = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
  const noTrailingDot = noLeadingDot.endsWith(".") ? noLeadingDot.slice(0, -1) : noLeadingDot;

  if (noTrailingDot.length === 0) {
    return "empty domain after normalization";
  }

  const normalized = noTrailingDot.toLowerCase();

  // Reject if the value is itself a known public suffix — applies to
  // both single-label (`com`, `uk`) and multi-label (`co.uk`, `com.au`)
  // entries. The "single dotless input is a host name" intuition only
  // holds for hosts NOT in the eTLD set; common gTLDs and ccTLDs would
  // otherwise sneak through.
  if (PUBLIC_SUFFIXES.has(normalized)) {
    return (
      `"${trimmed}" is a public suffix (eTLD). A cookie with this ` +
      `Domain attribute would be sent to every site under it, allowing ` +
      `cross-tenant session leakage. Use a more specific domain — e.g. ` +
      `".your-org.${normalized}" or "tenant.your-org.${normalized}".`
    );
  }

  return null;
}

/** Exposed for tests; do not depend on this outside the framework. */
export const _publicSuffixSet = PUBLIC_SUFFIXES;
