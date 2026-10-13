/**
 * `isLoopback(urlString)` — does this URL point at a loopback host?
 *
 * Pure-string check; deliberately avoids `dns.lookup` round-trips
 * because (a) dev MCP servers shouldn't make network calls to
 * classify their own configuration, and (b) DNS-based attacks can
 * cause `lookup` to resolve a non-loopback name to a loopback IP
 * (and vice versa) inside a single process lifetime.
 *
 * Accepts:
 *   - `localhost` (and `localhost.localdomain`)
 *   - `127.0.0.0/8` (any 127.x.x.x)
 *   - `0.0.0.0` (commonly bound for "listen on all interfaces" in dev)
 *   - `::1` (IPv6 loopback)
 *   - `[::1]` (the bracketed URL form)
 *
 * Rejects literally everything else, including:
 *   - `127.0.0.1.nip.io` (DNS rebinding helper that resolves to
 *     127.0.0.1 but is itself a public hostname)
 *   - `127-0-0-1.local` and similar
 *   - link-local (`169.254.x.x`) — not loopback even if dev-shaped
 *
 * Used by `execute_route` to refuse driving traffic at production
 * URLs without an explicit opt-in env var. See F7 in the security
 * audit and `SHIP_API_MCP_ALLOW_REMOTE`.
 */
export function isLoopback(urlString: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(urlString).hostname;
  } catch {
    return false;
  }

  // Node's URL.hostname returns the bracketed form for IPv6
  // (`[::1]` for `http://[::1]:port`). Strip the brackets so the
  // comparison matches the canonical address literal.
  const bracketsStripped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const host = bracketsStripped.toLowerCase();

  if (host === "localhost" || host === "localhost.localdomain") return true;
  if (host === "::1") return true;
  if (host === "0.0.0.0") return true;

  // IPv4 127.x.x.x — match by octet so 127.0.0.1.nip.io doesn't sneak through.
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split(".").map((s) => Number.parseInt(s, 10));
    return octets.every((o) => Number.isFinite(o) && o >= 0 && o <= 255);
  }

  // IPv6 `::ffff:127.0.0.1` (IPv4-mapped) — same posture: accept loopback.
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(host)) return true;

  return false;
}
