import { createServer } from 'node:http';
import { createFixtureClient } from './fixture-client.mjs';

/** Loopback-only HTTP fixture. No backend checkout, external service, or credentials are needed. */
export async function createQueryFixtureServer() {
  const fixture = createFixtureClient();
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'content-type,if-none-match,authorization');
    response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    response.setHeader('Access-Control-Expose-Headers', 'etag,x-request-id');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const abort = new globalThis.AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { operation, input } = JSON.parse(body);
      const result = await fixture.call(operation, input, {
        signal: abort.signal,
        headers: request.headers,
      });
      response.writeHead(result.status, {
        'content-type': 'application/json',
        'x-request-id': result.headers.requestId ?? 'query-fixture',
        ...(result.headers.etag ? { etag: result.headers.etag } : {}),
      });
      response.end(
        result.status === 204 || result.status === 304 ? undefined : JSON.stringify(result)
      );
    } catch (error) {
      if (abort.signal.aborted) return;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    ...fixture,
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    },
  };
}
