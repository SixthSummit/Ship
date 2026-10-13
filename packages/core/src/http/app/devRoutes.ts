import type { Hono } from "hono";
import {
  routeRegistry as defaultRegistry,
  type RouteEntry,
  type RouteRegistry,
} from "../../app/registry/routes.js";

/**
 * `registerDevRoutes(app, opts?)` — mounts `/dev/routes` (HTML index) +
 * `/dev/routes.json` (JSON dump) backed by the framework `RouteRegistry`.
 *
 * Recovers the human-discoverability we deliberately gave up by deferring
 * Scalar `/docs` / OpenAPI to v4.x. For internal devs joining the project
 * mid-stream the HTML index is "what routes does this app actually serve,
 * with what auth requirements, with what request schemas?" — answered
 * from runtime data, never stale.
 *
 * **Production safety**: gated by `opts.enabled` (default true only when
 * `WORKER_MODE === "local"` or `NODE_ENV` is `local` / `dev` / `development`).
 * Pass `enabled: true` to force-enable in other environments — e.g.,
 * staging behind an admin gateway. Production should NOT enable this; the
 * registry data is purely useful, not authenticated.
 */

export interface RegisterDevRoutesOptions {
  /** Override the default registry. */
  registry?: RouteRegistry;
  /**
   * Force enable / disable. Default: enabled when `WORKER_MODE === "local"`
   * or `NODE_ENV` is `local` / `dev` / `development`.
   */
  enabled?: boolean;
  /** Mount path prefix. Default `""` (routes at `/dev/routes` + `/dev/routes.json`). */
  prefix?: string;
}

function isDevEnvByDefault(): boolean {
  if (process.env.WORKER_MODE === "local") return true;
  const env = process.env.NODE_ENV ?? "";
  return env === "local" || env === "dev" || env === "development";
}

const STYLE = `
* { box-sizing: border-box; }
body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111; }
h1 { font-size: 18px; margin: 0 0 16px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
th { background: #f7f7f7; font-weight: 600; }
tr:hover { background: #fafafa; }
.method { display: inline-block; padding: 2px 6px; border-radius: 3px; font-weight: 600; font-size: 11px; color: #fff; }
.m-GET { background: #2962ff; }
.m-POST { background: #00897b; }
.m-PUT { background: #ef6c00; }
.m-PATCH { background: #6a1b9a; }
.m-DELETE { background: #c62828; }
.m-WS { background: #455a64; }
.m-OPTIONS, .m-HEAD { background: #757575; }
.path { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.tag { display: inline-block; padding: 1px 6px; margin-right: 4px; border-radius: 3px; background: #eef; color: #335; font-size: 11px; }
.deprecated { opacity: 0.55; }
.muted { color: #888; }
.empty { padding: 24px; text-align: center; color: #888; }
small.summary { color: #555; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function methodClass(method: string): string {
  return `m-${escapeHtml(method)}`;
}

function renderEntry(entry: RouteEntry): string {
  const method = `<span class="method ${methodClass(entry.method)}">${escapeHtml(entry.method)}</span>`;
  const path = `<span class="path">${escapeHtml(entry.path)}</span>`;
  const module = entry.module ? escapeHtml(entry.module) : `<span class="muted">—</span>`;
  const auth = entry.auth.required
    ? `<strong>required</strong>${entry.auth.provider ? ` <span class="muted">(${escapeHtml(entry.auth.provider)})</span>` : ""}`
    : `<span class="muted">none</span>`;
  const permissions =
    entry.permissions.length === 0
      ? `<span class="muted">—</span>`
      : entry.permissions.map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join("");
  const schemas = Object.keys(entry.schemas)
    .filter((k) => Boolean(entry.schemas[k as keyof typeof entry.schemas]))
    .map((k) => `<span class="tag">${escapeHtml(k)}</span>`)
    .join("");
  const policy: string[] = [];
  if (entry.rateLimit) {
    policy.push(
      `<span class="tag">rate-limit ${entry.rateLimit.max}/${Math.round(entry.rateLimit.windowMs / 1000)}s</span>`,
    );
  }
  if (entry.idempotent) policy.push(`<span class="tag">idempotent</span>`);
  if (entry.deprecated)
    policy.push(`<span class="tag" style="background:#fdd;color:#900">deprecated</span>`);

  const rowClass = entry.deprecated ? "deprecated" : "";
  return `<tr class="${rowClass}">
    <td>${method}</td>
    <td>${path}</td>
    <td>${module}</td>
    <td>${auth}</td>
    <td>${permissions || `<span class="muted">—</span>`}</td>
    <td>${schemas || `<span class="muted">—</span>`}</td>
    <td>${policy.join(" ") || `<span class="muted">—</span>`}</td>
  </tr>`;
}

function renderHtml(entries: readonly RouteEntry[]): string {
  const summary = `${entries.length} route${entries.length === 1 ? "" : "s"} registered`;
  const rows =
    entries.length === 0
      ? `<tr><td colspan="7" class="empty">No routes registered yet.</td></tr>`
      : entries.map(renderEntry).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ShipAPI · /dev/routes</title>
  <style>${STYLE}</style>
</head>
<body>
  <h1>Routes <small class="summary">— ${summary}</small></h1>
  <table>
    <thead>
      <tr>
        <th>Method</th><th>Path</th><th>Module</th><th>Auth</th>
        <th>Permissions</th><th>Schemas</th><th>Policy</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

/**
 * Convert Zod schemas to JSON Schema for the JSON dump so external tooling
 * (the MCP server, generated SDKs, dev-time debug consumers) can introspect
 * request shapes without a Zod runtime. Uses Zod v4's native
 * `z.toJSONSchema()` (the older `zod-to-json-schema` package doesn't
 * understand Zod v4's internal schema shape). Failed conversions degrade
 * to a presence flag so a malformed schema doesn't break the whole route.
 */
async function serializeSchemasForJson(entries: readonly RouteEntry[]): Promise<unknown[]> {
  const { z } = await import("zod");
  return entries.map((e) => {
    const out: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(e.schemas)) {
      if (!schema) continue;
      try {
        out[key] = z.toJSONSchema(schema as Parameters<typeof z.toJSONSchema>[0]);
      } catch {
        // Schema couldn't be serialized (unsupported types, recursion);
        // surface as a presence flag so consumers know it exists.
        out[key] = { _present: true };
      }
    }
    return { ...e, schemas: out };
  });
}

export function registerDevRoutes(app: Hono, opts: RegisterDevRoutesOptions = {}): void {
  const enabled = opts.enabled ?? isDevEnvByDefault();
  if (!enabled) return; // intentionally a no-op so production deploys don't expose the route table

  const registry = opts.registry ?? defaultRegistry;
  const prefix = opts.prefix ?? "";

  app.get(`${prefix}/dev/routes`, (c) => {
    const entries = registry.list();
    const html = renderHtml(entries);
    return c.html(html);
  });

  app.get(`${prefix}/dev/routes.json`, async (c) => {
    const entries = registry.list();
    const routes = await serializeSchemasForJson(entries);
    return c.json({ ok: true, count: entries.length, routes });
  });
}
