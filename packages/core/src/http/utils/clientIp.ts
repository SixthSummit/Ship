/**
 * `clientIp` — derive the client IP for trust-sensitive decisions.
 *
 * The framework default — used by `rateLimit()` and any other middleware
 * that needs a per-client key — refuses to trust `X-Forwarded-For`
 * unless the operator declares the upstream proxy ranges via
 * `trustProxy: string[]` (CIDR list). Without that declaration the
 * peer IP is used directly, even if XFF is present.
 *
 * The algorithm (rightmost-untrusted-IP) is the industry-standard
 * defense against XFF spoofing:
 *
 *   1. If the immediate peer is NOT in any `trustProxy` CIDR, the
 *      peer's IP wins — XFF is rejected entirely. An attacker
 *      contacting the server directly cannot inject XFF values that
 *      look like an internal proxy chain.
 *
 *   2. If the peer IS in the trust list, walk XFF right-to-left.
 *      Each rightmost entry that is also in the trust list is treated
 *      as a known proxy and skipped. The first entry that is NOT in
 *      the trust list is the *real* client IP.
 *
 *   3. If every XFF entry is in the trust list (i.e., the chain is
 *      composed entirely of internal proxies), fall back to the
 *      leftmost XFF entry. This is the rare case where the original
 *      client is itself inside the trust ring; we still return *some*
 *      identifier so the rate limiter has a key.
 *
 * Compare with the simpler "trust the leftmost XFF entry" pattern —
 * which is what the framework used before this defense landed and what
 * most tutorials still show. That pattern lets any anonymous attacker
 * rotate `X-Forwarded-For: <random>` per request and trivially bypass
 * per-IP rate limits on login / signup / password-reset endpoints.
 *
 * No new package dependency — IPv4 and IPv6 CIDR matching is inline.
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is normalized to IPv4 before
 * matching so a trust list of `10.0.0.0/8` covers `::ffff:10.0.0.1`.
 */

export interface ParsedCidr {
  readonly raw: string;
  readonly ip: bigint;
  readonly bits: number;
  readonly v4: boolean;
}

const V4_MAX_BITS = 32;
const V6_MAX_BITS = 128;

/**
 * Parse a CIDR (e.g. `10.0.0.0/8`, `::1/128`, `2001:db8::/32`) or a
 * bare IP (treated as `/32` for v4, `/128` for v6). Returns `null`
 * for malformed input — callers decide whether to throw or skip.
 */
export function parseCidr(input: string): ParsedCidr | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const slash = trimmed.lastIndexOf("/");
  let ipPart: string;
  let bitsPart: string | undefined;
  if (slash === -1) {
    ipPart = trimmed;
  } else {
    ipPart = trimmed.slice(0, slash);
    bitsPart = trimmed.slice(slash + 1);
  }

  const parsed = ipToBigInt(ipPart);
  if (parsed == null) return null;

  const maxBits = parsed.v4 ? V4_MAX_BITS : V6_MAX_BITS;
  let bits: number;
  if (bitsPart == null) {
    bits = maxBits;
  } else {
    if (!/^\d{1,3}$/.test(bitsPart)) return null;
    bits = Number.parseInt(bitsPart, 10);
    if (!Number.isFinite(bits) || bits < 0 || bits > maxBits) return null;
  }

  return { raw: trimmed, ip: parsed.ip, bits, v4: parsed.v4 };
}

/**
 * Parse an IP literal (v4 or v6) into a bigint. Returns `null` for
 * malformed input. IPv4 occupies the low 32 bits of the resulting
 * bigint (treated as v4); IPv6 is the full 128 bits.
 */
export function ipToBigInt(input: string): { ip: bigint; v4: boolean } | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const ip = input.trim();
  if (ip.length === 0) return null;

  // IPv4-mapped IPv6: `::ffff:1.2.3.4`. Strip the prefix and parse the
  // tail as v4 so trust lists declared in v4 still match.
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(ip)) {
    return parseV4(ip.slice("::ffff:".length));
  }

  if (ip.includes(":")) {
    return parseV6(ip);
  }
  return parseV4(ip);
}

function parseV4(s: string): { ip: bigint; v4: boolean } | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    acc = (acc << 8n) | BigInt(n);
  }
  return { ip: acc, v4: true };
}

function parseV6(s: string): { ip: bigint; v4: boolean } | null {
  // Reject obviously malformed shapes up front.
  if (s.includes(":::")) return null;
  // Bracketed addresses (`[::1]`) are stripped in URL parsing; the
  // caller should pass the inner literal.
  if (s.startsWith("[") || s.endsWith("]")) return null;

  // Embedded IPv4 (`::1:2:3:4:5:6:7.8.9.10` etc.) is rare and not
  // emitted by anything sensible inside XFF; reject for simplicity.
  if (/\d+\.\d+\.\d+\.\d+/.test(s)) return null;

  const doubleColon = s.indexOf("::");
  let groups: string[];
  if (doubleColon === -1) {
    groups = s.split(":");
    if (groups.length !== 8) return null;
  } else {
    if (s.indexOf("::", doubleColon + 2) !== -1) return null;
    const left = s.slice(0, doubleColon);
    const right = s.slice(doubleColon + 2);
    const leftGroups = left.length === 0 ? [] : left.split(":");
    const rightGroups = right.length === 0 ? [] : right.split(":");
    const fill = 8 - (leftGroups.length + rightGroups.length);
    if (fill < 0) return null;
    groups = [...leftGroups, ...new Array<string>(fill).fill("0"), ...rightGroups];
  }

  let acc = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    acc = (acc << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return { ip: acc, v4: false };
}

/** Check whether `ip` (literal) is contained by `cidr` (parsed). */
export function isInCidr(ip: string, cidr: ParsedCidr): boolean {
  const parsed = ipToBigInt(ip);
  if (!parsed) return false;
  // Family must match (after IPv4-mapped IPv6 normalization in
  // ipToBigInt, both sides agree on v4-vs-v6).
  if (parsed.v4 !== cidr.v4) return false;
  const maxBits = cidr.v4 ? V4_MAX_BITS : V6_MAX_BITS;
  const shift = BigInt(maxBits - cidr.bits);
  const mask = cidr.bits === 0 ? 0n : ((1n << BigInt(cidr.bits)) - 1n) << shift;
  return (parsed.ip & mask) === (cidr.ip & mask);
}

/** True if `ip` is contained by any CIDR in the parsed trust list. */
export function isTrustedProxy(ip: string, trustList: readonly ParsedCidr[]): boolean {
  for (const cidr of trustList) {
    if (isInCidr(ip, cidr)) return true;
  }
  return false;
}

/**
 * Compile a `trustProxy: string[]` config (CIDRs) once at middleware
 * construction time. Malformed entries are dropped silently — the
 * caller already had a chance to validate inputs and an
 * over-broad-but-typo'd list should not bring down request handling.
 */
export function compileTrustProxy(trustProxy: readonly string[] | undefined): ParsedCidr[] {
  if (!trustProxy || trustProxy.length === 0) return [];
  const out: ParsedCidr[] = [];
  for (const entry of trustProxy) {
    const parsed = parseCidr(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface ResolveClientIpOpts {
  /** The immediate peer IP (e.g. Node's `socket.remoteAddress`). */
  peerIp?: string;
  /** Raw `X-Forwarded-For` header value as the proxy chain sent it. */
  xff?: string;
  /** Compiled trust list. Empty list disables XFF trust entirely. */
  trustProxy: readonly ParsedCidr[];
}

/**
 * Resolve the client IP from peer + XFF + trust list. Returns
 * `"unknown"` only when no peer can be determined AND no XFF entry
 * survives the trust check — both should be rare in practice.
 */
export function resolveClientIp(opts: ResolveClientIpOpts): string {
  const { peerIp, xff, trustProxy } = opts;

  // No trust list → no XFF trust. Peer wins (or "unknown" if absent).
  if (trustProxy.length === 0) {
    return normalizeIp(peerIp) ?? "unknown";
  }

  // Peer must be in the trust list for XFF to be honored. An untrusted
  // peer cannot inject hops by setting its own XFF header.
  const normalizedPeer = normalizeIp(peerIp);
  if (!normalizedPeer || !isTrustedProxy(normalizedPeer, trustProxy)) {
    return normalizedPeer ?? "unknown";
  }

  // Walk XFF right-to-left, skipping trusted hops, returning the
  // first untrusted hop (the real client). If every hop is trusted,
  // fall back to the leftmost entry.
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => normalizeIp(s.trim()))
      .filter((s): s is string => Boolean(s));

    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      if (!isTrustedProxy(hop, trustProxy)) {
        return hop;
      }
    }
    if (hops.length > 0) return hops[0]!;
  }

  // No XFF (or empty after parsing) → trusted-peer is the best we have.
  return normalizedPeer;
}

/** Strip brackets and whitespace; reject obviously-malformed values. */
function normalizeIp(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // Strip `[::1]` brackets if present.
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  // Strip ::ffff: IPv4-mapped prefix for consistency with ipToBigInt.
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(inner)) {
    return inner.slice("::ffff:".length);
  }
  // Validate it actually parses; otherwise it's garbage from a buggy
  // proxy and we should not treat it as an IP.
  if (ipToBigInt(inner) == null) return undefined;
  return inner;
}
