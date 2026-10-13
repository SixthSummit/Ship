import type {
  AuthenticatedAccount,
  AuthProvider,
  AuthProviderContext,
} from "../../app/auth/AuthProvider.js";

/**
 * WebSocket subprotocol-header authentication — the locked v4 default.
 *
 * Clients open with two subprotocols: a versioning marker (e.g.
 * `ship-api.v1`) and a credential (`bearer.<token>`):
 *
 * ```ts
 * new WebSocket(url, ["ship-api.v1", `bearer.${token}`]);
 * ```
 *
 * The server parses the `Sec-WebSocket-Protocol` header during the upgrade
 * handshake (BEFORE the connection is established), runs the configured
 * `AuthProvider` chain, attaches the resolved Account to `ws.data`, and
 * responds with `Sec-WebSocket-Protocol: ship-api.v1` to confirm. Failed
 * auth rejects the upgrade with 401 — there's no "connected but
 * unauthenticated" intermediate state.
 *
 * Why subprotocol over alternatives — documented in
 * `.cursor/rules/security.mdc`:
 *   - URL token (`?token=...`): leaks into server / proxy / browser logs.
 *   - Cookie auth: same-origin web only; breaks RN+Expo and any future
 *     cross-origin client.
 *   - First-message handshake: introduces an authenticated-but-resourceful
 *     window before auth completes; footgun.
 *   - Subprotocol header: proper Authorization-header semantics, no
 *     leakage, no intermediate state, supported by every WS client
 *     (including React Native's). Adopted.
 *
 * **Operator note**: some load balancers and proxies log the
 * `Sec-WebSocket-Protocol` header. Firebase ID tokens are short-lived
 * (~1 h) which bounds the leakage window, but operators should configure
 * proxies to redact this header where possible.
 *
 * This file is the auth-extraction primitive — testable in isolation.
 * The full `upgradeWebSocket` integration with `@hono/node-ws` lives in
 * `wsAdapter.ts` (v4.x; lands when there's a concrete consumer).
 */

const BEARER_PREFIX = "bearer.";

export interface WsAuthExtractResult {
  /** All subprotocols the client presented, in order. */
  protocols: string[];
  /** The bearer token (without the `bearer.` prefix), if present. */
  bearerToken: string | null;
  /** First non-bearer subprotocol — what the server should echo back. */
  selectedSubprotocol: string | null;
}

/**
 * Parse the `Sec-WebSocket-Protocol` header value into the framework's
 * subprotocol-auth shape.
 */
export function extractWsAuth(headerValue: string | string[] | undefined): WsAuthExtractResult {
  const raw = Array.isArray(headerValue) ? headerValue.join(",") : (headerValue ?? "");
  const protocols = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  let bearerToken: string | null = null;
  let selectedSubprotocol: string | null = null;

  for (const proto of protocols) {
    // Case-insensitive prefix detection. F21: slice from the literal
    // prefix length; this is safe because every case variant of
    // `bearer.` is exactly the same ASCII length (7), so the
    // case-folded match position equals the original-string slice
    // index. A future prefix change to anything non-ASCII (or any
    // case-folding that changes string length) would break this
    // invariant and require switching to a regex-based extractor.
    if (proto.toLowerCase().startsWith(BEARER_PREFIX)) {
      // Use the FIRST bearer subprotocol; ignore subsequent ones.
      if (bearerToken === null) {
        bearerToken = proto.slice(BEARER_PREFIX.length);
      }
    } else if (selectedSubprotocol === null) {
      selectedSubprotocol = proto;
    }
  }

  return { protocols, bearerToken, selectedSubprotocol };
}

export interface AuthenticateWsUpgradeArgs<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
> {
  /** All upgrade-request headers, lower-cased keys. */
  headers: Readonly<Record<string, string | undefined>>;
  provider: AuthProvider<TAccount>;
  /**
   * If `true`, missing-token connections are admitted (account=null).
   * Present-but-bad tokens still reject — same semantics as `requireAuth`.
   */
  optional?: boolean;
}

export type AuthenticateWsUpgradeResult<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
> =
  | {
      ok: true;
      /** Resolved Account, or `null` when `optional: true` and no token was supplied. */
      account: TAccount | null;
      /** First non-bearer subprotocol — the server echoes this. */
      selectedSubprotocol: string | null;
      /** Verified claims (when ok). */
      claims: import("../../app/auth/AuthProvider.js").AuthClaims | null;
    }
  | {
      ok: false;
      /** 401 (auth failure) or 403 (account not registered). */
      status: 401 | 403;
      reason: string;
    };

/**
 * Run the AuthProvider chain against a WebSocket upgrade request. Pure —
 * does not touch the underlying socket. The caller is responsible for
 * accepting (with `Sec-WebSocket-Protocol: <selectedSubprotocol>`) or
 * rejecting (with `status`) based on the returned verdict.
 */
export async function authenticateWsUpgrade<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
>(args: AuthenticateWsUpgradeArgs<TAccount>): Promise<AuthenticateWsUpgradeResult<TAccount>> {
  const { bearerToken, selectedSubprotocol } = extractWsAuth(
    args.headers["sec-websocket-protocol"],
  );

  if (!bearerToken) {
    if (args.optional) {
      return { ok: true, account: null, selectedSubprotocol, claims: null };
    }
    return { ok: false, status: 401, reason: "Missing bearer.<token> subprotocol" };
  }

  const ctx: AuthProviderContext = {
    headers: args.headers,
    rawCredential: bearerToken,
  };

  const verifyResult = await args.provider.verify(ctx);
  if (!verifyResult.ok) {
    if (verifyResult.reason === "missing-token" && args.optional) {
      return { ok: true, account: null, selectedSubprotocol, claims: null };
    }
    return {
      ok: false,
      status: 401,
      reason: verifyResult.message ?? `Authentication failed (${verifyResult.reason})`,
    };
  }

  const account = await args.provider.resolve(verifyResult.claims);
  if (account === null) {
    if (args.provider.onUnknownAccount === "next") {
      return {
        ok: true,
        account: null,
        selectedSubprotocol,
        claims: verifyResult.claims,
      };
    }
    return {
      ok: false,
      status: 403,
      reason: "No account registered for this credential",
    };
  }

  return {
    ok: true,
    account,
    selectedSubprotocol,
    claims: verifyResult.claims,
  };
}
