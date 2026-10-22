export const contractMetadata = Object.freeze({
  fixtureProtocolVersion: 1,
  contractVersion: '0.0.0-fixture.1',
  graphHash: 'sha256:c858de1510d38cbbead7923f59ae053bd31ec5bbb90fd8ee16da5d95de541389',
  operations: Object.freeze({
    'accounts.get': Object.freeze({ transport: 'http' }),
    'accounts.create': Object.freeze({ transport: 'http' }),
    'accounts.delete': Object.freeze({ transport: 'http' }),
    'public.status': Object.freeze({ transport: 'http' }),
    'oauth.callback': Object.freeze({ transport: 'http' }),
    'reports.download': Object.freeze({ transport: 'download' }),
    'assets.upload': Object.freeze({ transport: 'upload' }),
    'events.watch': Object.freeze({ transport: 'stream' }),
    'agent.stream': Object.freeze({ transport: 'stream' }),
    'chat.socket': Object.freeze({ transport: 'socket' }),
  }),
  channels: Object.freeze({
    'account.updated': Object.freeze({ scope: 'actor' }),
    'room.messages': Object.freeze({ scope: 'resource' }),
    'tenant.audit': Object.freeze({ scope: 'tenant' }),
  }),
});

/** Browser-safe runtime projection matching ShipAPI's current ClientContract shape. */
export const clientContract = Object.freeze({
  schemaVersion: 1,
  appId: 'ship-angular-conformance',
  fingerprint: contractMetadata.graphHash,
  channels: Object.freeze({
    'account.updated': Object.freeze({
      scope: 'actor',
      payload: 'AccountUpdated',
      presence: false,
    }),
    'room.messages': Object.freeze({
      scope: 'resource',
      payload: 'RoomMessage',
      presence: true,
    }),
    'tenant.audit': Object.freeze({
      scope: 'tenant',
      payload: 'TenantAuditEntry',
      presence: false,
    }),
  }),
  operations: Object.freeze([
    Object.freeze({
      id: 'accounts.get',
      success: Object.freeze([{ status: 200 }]),
      errors: Object.freeze([{ code: 'ACCOUNT_NOT_FOUND', status: 404 }]),
    }),
    Object.freeze({
      id: 'accounts.create',
      success: Object.freeze([{ status: 201 }]),
      errors: Object.freeze([{ code: 'CONFLICT', status: 409 }]),
      publishes: Object.freeze(['account.updated']),
    }),
    Object.freeze({
      id: 'accounts.delete',
      success: Object.freeze([{ status: 204 }]),
      errors: Object.freeze([{ code: 'ACCOUNT_NOT_FOUND', status: 404 }]),
    }),
    Object.freeze({
      id: 'public.status',
      success: Object.freeze([{ status: 200 }]),
      errors: Object.freeze([]),
    }),
    Object.freeze({
      id: 'oauth.callback',
      transport: Object.freeze({ kind: 'http', metadata: Object.freeze({ response: 'redirect' }) }),
      success: Object.freeze([{ status: 302 }]),
      errors: Object.freeze([]),
    }),
    Object.freeze({
      id: 'reports.download',
      success: Object.freeze([{ status: 200 }]),
      errors: Object.freeze([{ code: 'REPORT_NOT_FOUND', status: 404 }]),
    }),
    Object.freeze({
      id: 'assets.upload',
      success: Object.freeze([{ status: 201 }]),
      errors: Object.freeze([{ code: 'UPLOAD_REJECTED', status: 422 }]),
    }),
    Object.freeze({
      id: 'events.watch',
      success: Object.freeze([{ status: 200 }]),
      errors: Object.freeze([]),
    }),
    Object.freeze({
      id: 'agent.stream',
      method: 'GET',
      path: '/agents/:agentId/stream',
      success: Object.freeze([{ status: 200 }]),
      errors: Object.freeze([{ code: 'AGENT_NOT_FOUND', status: 404 }]),
      response: Object.freeze({
        mode: 'stream',
        framing: 'sse',
        frame: Object.freeze({ $ref: '#/schemas/AgentDelta' }),
        terminal: Object.freeze({ $ref: '#/schemas/AgentUsage' }),
        limits: Object.freeze({ heartbeatMs: 250, maxDurationMs: 10_000, maxFrames: 64 }),
      }),
    }),
    Object.freeze({
      id: 'chat.socket',
      success: Object.freeze([{ status: 101 }]),
      errors: Object.freeze([{ code: 'ROOM_NOT_FOUND', status: 404 }]),
      publishes: Object.freeze(['room.messages']),
    }),
  ]),
});
