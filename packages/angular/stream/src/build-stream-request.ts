import { ProtocolError } from '@sixthsummit/ship-angular/operations';
import type { ShipStreamManifestOperation, ShipStreamMethod } from './ship-stream-manifest';

/** A concrete stream request: the operation's declared method/path with its input applied. */
export interface ShipStreamRequest {
  readonly url: string;
  readonly method: ShipStreamMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * Apply an operation input to its declared method and path.
 *
 * `params` fill `:name` placeholders, `query` becomes the search string, and `body`
 * is JSON-encoded for `POST`. `Accept: text/event-stream` is always set — the
 * wire contract uses it to select the streaming response.
 */
export function buildStreamRequest(
  baseUrl: string,
  operation: ShipStreamManifestOperation,
  input: unknown
): ShipStreamRequest {
  const parts = readInput(input);
  const url = new URL(`${trimTrailingSlash(baseUrl)}${applyParams(operation, parts.params)}`);
  appendQuery(url, parts.query);

  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (operation.method === 'GET') {
    if (parts.body !== undefined) {
      throw new ProtocolError(`Operation ${operation.id} cannot send a body with GET`, {
        reason: 'invalid-envelope',
      });
    }
    return { url: url.href, method: 'GET', headers: Object.freeze(headers) };
  }

  headers['content-type'] = 'application/json';
  return {
    url: url.href,
    method: 'POST',
    headers: Object.freeze(headers),
    body: JSON.stringify(parts.body ?? {}),
  };
}

interface StreamInputParts {
  readonly params: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
}

function readInput(input: unknown): StreamInputParts {
  if (!isRecord(input)) return { params: {}, query: {}, body: undefined };
  return {
    params: isRecord(input['params']) ? input['params'] : {},
    query: isRecord(input['query']) ? input['query'] : {},
    body: input['body'],
  };
}

function applyParams(
  operation: ShipStreamManifestOperation,
  params: Readonly<Record<string, unknown>>
): string {
  return operation.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      throw new ProtocolError(`Operation ${operation.id} is missing the path parameter ${name}`, {
        reason: 'invalid-envelope',
      });
    }
    return encodeURIComponent(String(value));
  });
}

function appendQuery(url: URL, query: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) url.searchParams.append(name, String(item));
      }
      continue;
    }
    url.searchParams.append(name, String(value));
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
