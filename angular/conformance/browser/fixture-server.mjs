import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WEB_SOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Start the deterministic cross-origin HTTP/WebSocket server used by browser conformance. */
export async function createBrowserFixtureServer() {
  let allowedOrigin;
  let redirectOrigin;
  let socketConnections = 0;
  const openSockets = new Set();
  const metrics = {
    requests: [],
    uploadAborted: false,
    slowDownloadClosed: false,
    slowStreamClosed: false,
    wireStreamAborted: false,
    socketConnections: [],
    socketMessages: [],
    socketClientCloses: [],
  };

  const server = createServer((request, response) => {
    const url = new globalThis.URL(request.url ?? '/', 'http://fixture.invalid');
    if (request.method === 'OPTIONS') {
      writeCors(response, allowedOrigin, request.headers.origin);
      response.writeHead(204, {
        'Access-Control-Allow-Headers':
          request.headers['access-control-request-headers'] ??
          'content-type,x-csrf-token,x-request-id,idempotency-key',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Max-Age': '60',
      });
      response.end();
      return;
    }

    if (url.pathname !== '/metrics') recordRequest(metrics, request, url.pathname);
    writeCors(response, allowedOrigin, request.headers.origin);

    if (url.pathname === '/download/redirect') {
      response.writeHead(302, { Location: `${redirectOrigin}/download` });
      response.end();
      return;
    }

    if (url.pathname === '/session/set') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'browser-session=alpha; Path=/; HttpOnly; SameSite=Lax',
      });
      response.end(JSON.stringify({ ready: true }));
      return;
    }

    if (url.pathname === '/download' || url.pathname === '/download/slow') {
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': "attachment; filename*=UTF-8''browser-proof.pdf",
        'Content-Length': '6',
        'X-Request-Id': 'browser-download-request',
        ETag: 'browser-download-v1',
      });
      if (url.pathname === '/download/slow') {
        const timer = setTimeout(() => response.end(Buffer.from([0, 1, 2, 3, 4, 255])), 2_000);
        response.on('close', () => {
          clearTimeout(timer);
          if (!response.writableEnded) metrics.slowDownloadClosed = true;
        });
        return;
      }
      response.end(Buffer.from([0, 1, 2, 3, 4, 255]));
      return;
    }

    if (url.pathname === '/download/error') {
      response.writeHead(404, {
        'Content-Type': 'application/json',
        'X-Request-Id': 'browser-download-error',
      });
      response.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'REPORT_NOT_FOUND',
            message: 'The report does not exist',
            details: { reportId: 'missing' },
          },
        })
      );
      return;
    }

    if (
      url.pathname === '/upload' ||
      url.pathname === '/upload/reject' ||
      url.pathname === '/upload/slow'
    ) {
      const chunks = [];
      let completed = false;
      request.on('data', chunk => chunks.push(chunk));
      request.on('aborted', () => {
        if (url.pathname === '/upload/slow') metrics.uploadAborted = true;
      });
      request.on('close', () => {
        if (url.pathname === '/upload/slow' && !completed) metrics.uploadAborted = true;
      });
      // The browser can finish sending the body before cancelling the pending response.
      // Observe that transport close too; a completed request body is not a completed exchange.
      response.on('close', () => {
        if (url.pathname === '/upload/slow' && !response.writableFinished) {
          metrics.uploadAborted = true;
        }
      });
      request.on('end', () => {
        completed = true;
        if (url.pathname === '/upload/slow') return;
        if (url.pathname === '/upload/reject') {
          response.writeHead(422, {
            'Content-Type': 'application/json',
            'X-Request-Id': 'browser-upload-error',
          });
          response.end(
            JSON.stringify({
              success: false,
              error: {
                code: 'UPLOAD_REJECTED',
                message: 'The fixture rejected the upload',
                details: { field: 'asset' },
              },
            })
          );
          return;
        }
        response.writeHead(201, {
          'Content-Type': 'application/json',
          'X-Request-Id': 'browser-upload-request',
          'Idempotency-Replayed': 'false',
        });
        setTimeout(
          () =>
            response.end(
              JSON.stringify({
                assetId: 'asset-browser',
                receivedBytes: Buffer.concat(chunks).length,
              })
            ),
          100
        );
      });
      if (url.pathname === '/upload/slow') {
        request.pause();
        setTimeout(() => request.resume(), 2_000);
      }
      return;
    }

    if (url.pathname === '/stream' || url.pathname === '/stream/slow') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Request-Id': 'browser-stream-request',
      });
      response.flushHeaders();
      response.write('id: event-1\r\nevent: account\r\ndata: {"value":');
      setTimeout(() => {
        if (response.destroyed) return;
        response.write('1}\r\n\r\n');
        if (url.pathname === '/stream/slow') return;
        response.write('id: event-2\ndata: {"value":2}\n\n');
        response.end();
      }, 20);
      if (url.pathname === '/stream/slow') {
        response.on('close', () => {
          if (!response.writableEnded) metrics.slowStreamClosed = true;
        });
      }
      return;
    }

    if (url.pathname === '/wire-stream') {
      // The canonical SSE wire contract, written verbatim.
      const mode = url.searchParams.get('mode') ?? 'frames';
      if (mode === 'error-before-frame') {
        response.writeHead(404, {
          'Content-Type': 'application/json',
          'X-Request-Id': 'browser-wire-stream-error',
        });
        response.end(
          JSON.stringify({
            success: false,
            error: {
              code: 'AGENT_NOT_FOUND',
              message: 'The agent does not exist',
              details: { agentId: 'missing' },
            },
          })
        );
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Ship-Stream': 'sse/1',
        'X-Request-Id': 'browser-wire-stream-request',
      });
      response.flushHeaders();
      if (mode === 'terminal-only') {
        // A handler that returns without emitting still opens the stream.
        response.write(`id: 1\nevent: terminal\ndata: ${JSON.stringify(null)}\n\n`);
        response.end();
        return;
      }
      response.write(`: hb ${Date.now()}\n\n`);
      response.write(`id: 1\nevent: frame\ndata: ${JSON.stringify({ delta: 'he' })}\n\n`);
      if (mode === 'open') {
        response.on('close', () => {
          if (!response.writableEnded) metrics.wireStreamAborted = true;
        });
        return;
      }
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        if (mode === 'error-after-frame') {
          // `details` is omitted when absent; the seq keeps counting across event kinds.
          response.write(
            `id: 2\nevent: error\ndata: ${JSON.stringify({
              code: 'STREAM_MAX_FRAMES_EXCEEDED',
              status: 500,
              message: 'The stream exceeded its declared frame budget',
            })}\n\n`
          );
          response.end();
          return;
        }
        // A heartbeat never consumes a sequence number.
        response.write(`: hb ${Date.now()}\n\n`);
        response.write(`id: 2\nevent: frame\ndata: ${JSON.stringify({ delta: 'llo' })}\n\n`);
        // An unknown event name is ignored by conforming clients.
        response.write(`event: diagnostic\ndata: ${JSON.stringify({ ignored: true })}\n\n`);
        response.write(`id: 3\nevent: terminal\ndata: ${JSON.stringify({ tokens: 42 })}\n\n`);
        response.end();
      }, 25);
      response.on('close', () => clearTimeout(timer));
      return;
    }

    if (url.pathname === '/metrics') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(metrics));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Missing' } })
    );
  });

  server.on('connection', socket => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });

  server.on('upgrade', (request, socket) => {
    const url = new globalThis.URL(request.url ?? '/', 'http://fixture.invalid');
    if (!['/socket', '/socket/invalid', '/socket/no-protocol'].includes(url.pathname)) {
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const requestedProtocols = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    const noProtocol = url.pathname === '/socket/no-protocol';
    if (typeof key !== 'string' || (!noProtocol && !requestedProtocols.includes('ship.v1'))) {
      socket.destroy();
      return;
    }

    socketConnections += 1;
    const connection = socketConnections;
    const ticket = url.searchParams.get('ticket');
    if (url.pathname === '/socket')
      metrics.socketConnections.push({
        connection,
        origin: request.headers.origin,
        protocol: 'ship.v1',
        ticket,
      });
    const accept = createHash('sha1').update(`${key}${WEB_SOCKET_GUID}`).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(noProtocol ? [] : ['Sec-WebSocket-Protocol: ship.v1']),
        '\r\n',
      ].join('\r\n')
    );
    socket.write(
      textFrame(
        url.pathname === '/socket/invalid'
          ? 'invalid-json'
          : JSON.stringify({ kind: 'connected', connection })
      )
    );

    if (connection === 1) {
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.end(closeFrame(4001, 'refresh ticket'));
      }, 25);
      return;
    }

    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const decoded = decodeClientFrame(pending);
        if (decoded === undefined) return;
        pending = pending.subarray(decoded.bytes);
        if (decoded.opcode === 0x8) {
          const code = decoded.payload.readUInt16BE(0);
          metrics.socketClientCloses.push({ path: url.pathname, code });
          socket.end(closeFrame(code, 'closed'));
          return;
        }
        if (decoded.opcode !== 0x1) continue;
        const message = decoded.payload.toString('utf8');
        metrics.socketMessages.push(message);
        socket.write(textFrame(JSON.stringify({ kind: 'echo', value: message })));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Fixture server has no port');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    wsOrigin: `ws://127.0.0.1:${address.port}`,
    setRedirectOrigin(value) {
      redirectOrigin = value;
    },
    setAllowedOrigin(value) {
      allowedOrigin = value;
    },
    snapshot: () => globalThis.structuredClone(metrics),
    close: () =>
      new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        for (const socket of openSockets) socket.destroy();
        server.closeAllConnections?.();
      }),
  };
}

function writeCors(response, allowedOrigin, requestOrigin) {
  if (allowedOrigin !== undefined && requestOrigin === allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  response.setHeader('Vary', 'Origin');
  response.setHeader(
    'Access-Control-Expose-Headers',
    'X-Request-Id, Retry-After, ETag, Content-Type, Content-Disposition, Idempotency-Key, Idempotency-Replayed, Idempotency-Result, X-Ship-Stream'
  );
}

function recordRequest(metrics, request, path) {
  metrics.requests.push({
    method: request.method,
    path,
    origin: request.headers.origin,
    cookie: request.headers.cookie,
    authorization: request.headers.authorization,
    customCredential: request.headers['x-ship-token'],
    csrf: request.headers['x-csrf-token'],
    requestId: request.headers['x-request-id'],
    idempotencyKey: request.headers['idempotency-key'],
    contentType: request.headers['content-type'],
  });
}

function textFrame(text) {
  return serverFrame(0x1, Buffer.from(text));
}

function closeFrame(code, reason) {
  const reasonBytes = Buffer.from(reason);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return serverFrame(0x8, payload);
}

function serverFrame(opcode, payload) {
  if (payload.length >= 126) throw new RangeError('Fixture WebSocket payload is too large');
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

function decodeClientFrame(buffer) {
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    const longLength = buffer.readBigUInt64BE(2);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Frame is too large');
    length = Number(longLength);
    offset = 10;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskBytes;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, bytes: offset + length };
}
