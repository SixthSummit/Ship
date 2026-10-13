import { ProtocolError } from '@sixthsummit/ship-angular/operations';
import { describe, expect, it } from 'vitest';
import {
  resolveShipStreamOperation,
  type ShipStreamManifest,
  type ShipStreamManifestEntry,
} from './ship-stream-manifest';

const FINGERPRINT = `sha256:${'a'.repeat(64)}` as const;

const streamEntry: ShipStreamManifestEntry = {
  id: 'agent.run',
  method: 'POST',
  path: '/agents/:agentId/run',
  success: [{ status: 200 }],
  errors: [{ code: 'AGENT_NOT_FOUND', status: 404 }],
  response: {
    mode: 'stream',
    framing: 'sse',
    frame: { $ref: '#/schemas/Delta' },
    terminal: { $ref: '#/schemas/Usage' },
    limits: { heartbeatMs: 15_000, maxDurationMs: 60_000, maxFrames: 128 },
  },
};

function manifest(...operations: readonly ShipStreamManifestEntry[]): ShipStreamManifest {
  return {
    schemaVersion: 1,
    appId: 'ship-angular-tests',
    fingerprint: FINGERPRINT,
    operations,
  };
}

function withResponse(
  overrides: Partial<NonNullable<ShipStreamManifestEntry['response']>>
): ShipStreamManifestEntry {
  return {
    ...streamEntry,
    response: { ...streamEntry.response, mode: 'stream', ...overrides },
  };
}

describe('resolveShipStreamOperation', () => {
  it('projects the declared method, path, statuses, error codes, and limits', () => {
    expect(resolveShipStreamOperation(manifest(streamEntry), 'agent.run')).toEqual({
      id: 'agent.run',
      method: 'POST',
      path: '/agents/:agentId/run',
      successStatuses: [200],
      declaredErrorCodes: ['AGENT_NOT_FOUND'],
      response: {
        mode: 'stream',
        framing: 'sse',
        frame: { $ref: '#/schemas/Delta' },
        terminal: { $ref: '#/schemas/Usage' },
        limits: { heartbeatMs: 15_000, maxDurationMs: 60_000, maxFrames: 128 },
      },
    });
  });

  it('omits the terminal schema when the operation declares none', () => {
    const entry: ShipStreamManifestEntry = {
      ...streamEntry,
      response: { ...streamEntry.response, mode: 'stream', terminal: undefined },
    };

    const resolved = resolveShipStreamOperation(manifest(entry), 'agent.run');

    expect('terminal' in resolved.response).toBe(false);
  });

  it.each([
    ['a non-1 schema version', { ...manifest(streamEntry), schemaVersion: 2 as unknown as 1 }],
    ['an empty app ID', { ...manifest(streamEntry), appId: '' }],
    [
      'a malformed fingerprint',
      { ...manifest(streamEntry), fingerprint: 'sha256:short' as `sha256:${string}` },
    ],
    [
      'a non-array operation list',
      {
        ...manifest(streamEntry),
        operations: undefined as unknown as readonly ShipStreamManifestEntry[],
      },
    ],
  ])('rejects a manifest with %s', (_label, invalid) => {
    expect(() => resolveShipStreamOperation(invalid, 'agent.run')).toThrow(ProtocolError);
  });

  it('rejects an operation that is absent from the manifest', () => {
    expect(() => resolveShipStreamOperation(manifest(streamEntry), 'agent.missing')).toThrow(
      /absent from the ShipAPI manifest/
    );
  });

  it('rejects an operation that declares no streaming response', () => {
    const unary: ShipStreamManifestEntry = { id: 'agent.get', success: [], errors: [] };

    expect(() => resolveShipStreamOperation(manifest(unary), 'agent.get')).toThrow(
      /response mode "stream"/
    );
  });

  it('rejects a non-stream response mode', () => {
    expect(() =>
      resolveShipStreamOperation(manifest(withResponse({ mode: 'json' })), 'agent.run')
    ).toThrow(/response mode "stream"/);
  });

  it('rejects an unsupported framing', () => {
    expect(() =>
      resolveShipStreamOperation(manifest(withResponse({ framing: 'ndjson' })), 'agent.run')
    ).toThrow(/unsupported stream framing/);
  });

  it.each([['PUT'], [undefined]])('rejects the unsupported stream method %s', method => {
    const entry = { ...streamEntry, method } as ShipStreamManifestEntry;

    expect(() => resolveShipStreamOperation(manifest(entry), 'agent.run')).toThrow(
      /unsupported stream method/
    );
  });

  it.each([['agents/run'], [undefined]])('rejects the invalid stream path %s', path => {
    const entry = { ...streamEntry, path } as ShipStreamManifestEntry;

    expect(() => resolveShipStreamOperation(manifest(entry), 'agent.run')).toThrow(
      /invalid stream path/
    );
  });

  it.each([
    ['missing limits', undefined],
    ['a zero heartbeat', { heartbeatMs: 0, maxDurationMs: 1, maxFrames: 1 }],
    ['a fractional duration', { heartbeatMs: 1, maxDurationMs: 1.5, maxFrames: 1 }],
    ['a negative frame budget', { heartbeatMs: 1, maxDurationMs: 1, maxFrames: -1 }],
  ])('rejects %s', (_label, limits) => {
    expect(() =>
      resolveShipStreamOperation(manifest(withResponse({ limits })), 'agent.run')
    ).toThrow(/invalid stream limits/);
  });

  it('rejects an invalid success or error projection', () => {
    const entry = {
      ...streamEntry,
      success: undefined,
    } as unknown as ShipStreamManifestEntry;

    expect(() => resolveShipStreamOperation(manifest(entry), 'agent.run')).toThrow(
      /invalid success or error projection/
    );
  });
});
