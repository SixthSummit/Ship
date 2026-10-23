import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import type { ShipConsoleClient, ShipConsoleContract } from './public-api';

declare const typed: OperationClient<ShipConsoleContract>;
// A typed operation client over the console contract is accepted as-is.
const client: ShipConsoleClient = typed;

async function verify(): Promise<void> {
  const result = await typed.call('console.jobs.retry', { body: { runId: 'r' } });
  if (result.ok && result.notModified !== true) {
    result.data.run.status satisfies string;
  }
  if (!result.ok) {
    result.error.code satisfies 'JOB_RUN_NOT_FOUND' | 'AUTHORIZATION_ERROR' | (string & {});
  }
  // @ts-expect-error unknown console operation ids are rejected
  await typed.call('console.jobs.nope', {});
}
void [client, verify];
