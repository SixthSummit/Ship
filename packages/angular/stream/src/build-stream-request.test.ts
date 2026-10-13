import { ProtocolError } from '@sixthsummit/ship-angular/operations';
import { describe, expect, it } from 'vitest';
import { buildStreamRequest } from './build-stream-request';
import type { ShipStreamManifestOperation } from './ship-stream-manifest';

function operation(
  overrides: Partial<ShipStreamManifestOperation> = {}
): ShipStreamManifestOperation {
  return {
    id: 'agent.run',
    method: 'GET',
    path: '/agents/:agentId/run',
    successStatuses: [200],
    declaredErrorCodes: [],
    response: {
      mode: 'stream',
      framing: 'sse',
      frame: {},
      limits: { heartbeatMs: 1, maxDurationMs: 1, maxFrames: 1 },
    },
    ...overrides,
  };
}

describe('buildStreamRequest', () => {
  it('encodes path parameters, keeps a base path prefix, and always accepts SSE', () => {
    const request = buildStreamRequest('https://api.example.test/v1', operation(), {
      params: { agentId: 'agent 1/2' },
    });

    expect(request).toEqual({
      url: 'https://api.example.test/v1/agents/agent%201%2F2/run',
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
  });

  it('tolerates a trailing slash on the base URL', () => {
    const request = buildStreamRequest('https://api.example.test/v1/', operation(), {
      params: { agentId: 'a' },
    });

    expect(request.url).toBe('https://api.example.test/v1/agents/a/run');
  });

  it('serializes query values, repeats arrays, and omits null and undefined', () => {
    const request = buildStreamRequest('https://api.example.test', operation(), {
      params: { agentId: 'a' },
      query: {
        include: ['frames', 'usage'],
        since: 10,
        cursor: undefined,
        filter: null,
        sparse: [undefined, 'kept'],
      },
    });

    expect(new URL(request.url).search).toBe('?include=frames&include=usage&since=10&sparse=kept');
  });

  it('treats a missing input as an empty input', () => {
    const request = buildStreamRequest(
      'https://api.example.test',
      operation({ path: '/events' }),
      undefined
    );

    expect(request.url).toBe('https://api.example.test/events');
  });

  it.each([[undefined], [null], ['']])('rejects the missing path parameter %s', value => {
    expect(() =>
      buildStreamRequest('https://api.example.test', operation(), {
        params: { agentId: value },
      })
    ).toThrow(ProtocolError);
  });

  it('rejects a body on a GET stream', () => {
    expect(() =>
      buildStreamRequest('https://api.example.test', operation(), {
        params: { agentId: 'a' },
        body: { prompt: 'hello' },
      })
    ).toThrow(/cannot send a body with GET/);
  });

  it('JSON-encodes the body of a POST stream', () => {
    const request = buildStreamRequest('https://api.example.test', operation({ method: 'POST' }), {
      params: { agentId: 'a' },
      body: { prompt: 'hello' },
    });

    expect(request).toEqual({
      url: 'https://api.example.test/agents/a/run',
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: '{"prompt":"hello"}',
    });
  });

  it('sends an empty JSON object when a POST stream declares no body', () => {
    const request = buildStreamRequest('https://api.example.test', operation({ method: 'POST' }), {
      params: { agentId: 'a' },
    });

    expect(request.body).toBe('{}');
  });
});
