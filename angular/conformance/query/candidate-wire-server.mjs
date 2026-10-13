import { notModified, success } from './fixture-client.mjs';
import { createQueryFixtureServer } from './fixture-server.mjs';

/** Node-side controls for the real HTTP fixture. Browser calls these through Playwright bindings. */
export async function createCandidateWireServer() {
  const server = await createQueryFixtureServer();
  const releases = [];
  return {
    origin: server.origin,
    close: () => server.close(),
    async control(action, value) {
      if (action === 'enqueue') {
        releases.push(
          server.enqueue(
            value.status === 304 ? notModified(value.etag) : success(value.data, 200, value.etag),
            { held: value.held ?? false }
          )
        );
        return releases.length - 1;
      }
      if (action === 'release') {
        releases[value]();
        return;
      }
      if (action === 'started') {
        await server.started(value);
        return;
      }
      if (action === 'aborted') {
        const signal = server.calls[value - 1].options.signal;
        if (!signal.aborted)
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        return true;
      }
      if (action === 'metrics')
        return {
          count: server.calls.length,
          headers: server.calls.map(call => call.options.headers),
        };
      throw new Error(`Unknown wire control: ${action}`);
    },
  };
}
