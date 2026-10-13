import '@angular/compiler';
import { OperationSessionAuthAdapter } from '@sixthsummit/ship-angular/auth';
import { createOperationForm } from '@sixthsummit/ship-angular/forms';
import { createPolicyClient } from '@sixthsummit/ship-angular/operations';
import { createShipApiClientExecutor } from '@sixthsummit/ship-angular/ship-api';
import { createFixtureClient } from '@sixthsummit/ship-api-conformance-client';
import {
  accountFormBinding,
  clientContract,
  type FixtureContract,
} from '@sixthsummit/ship-api-conformance-contract';

declare const __FIXTURE_ORIGIN__: string;
export async function run() {
  const executor = createShipApiClientExecutor<FixtureContract>(clientContract, ({ credentials }) =>
    createFixtureClient({ baseUrl: __FIXTURE_ORIGIN__, credentials })
  );
  const policy = {
    authentication: 'anonymous',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
    transport: 'http',
  } as const;
  const client = createPolicyClient(executor, {
    policies: {
      'accounts.get': policy,
      'accounts.create': { ...policy, safety: 'unsafe' },
      'accounts.delete': policy,
      'public.status': policy,
      'session.me': policy,
      'session.refresh': policy,
      'session.sign-out': policy,
    },
    credentials: { kind: 'anonymous' },
  });
  const read = await client.call('accounts.get', { params: { accountId: 'browser' } });
  const missing = await client.call('accounts.get', { params: { accountId: 'missing' } });
  if (
    missing.ok ||
    missing.status !== 404 ||
    missing.error.code !== 'ACCOUNT_NOT_FOUND' ||
    typeof missing.error.details !== 'object' ||
    missing.error.details === null ||
    !('extension' in missing.error.details) ||
    missing.error.details.extension !== 'preserved'
  )
    throw new Error('Browser declared error lost details');
  const invalid = await client.call('accounts.create', { body: { name: '' } });
  if (invalid.ok || invalid.status !== 400) throw new Error('Browser validation failed');
  if (
    !read.ok ||
    read.notModified ||
    read.data.id !== 'browser' ||
    read.headers.requestId !== 'joint-request'
  )
    throw new Error('Browser metadata/result failed');
  const form = createOperationForm<
    FixtureContract,
    'accounts.create',
    { name: string; note: string | null; enabled: boolean }
  >(accountFormBinding);
  form.form.controls.name.setValue('Browser');
  const made = await client.call('accounts.create', { body: form.body() });
  if (!made.ok || made.status !== 201) throw new Error('Generated form failed');
  form.destroy();
  const removed = await client.call('accounts.delete', { params: { accountId: 'browser' } });
  if (!removed.ok || removed.status !== 204) throw new Error('Bodyless response failed');
  const controller = new AbortController();
  const pending = client.call(
    'public.status',
    { query: { delayMs: 2000 } },
    { signal: controller.signal }
  );
  const deadline = Date.now() + 1500;
  while (!(await (await fetch(`${__FIXTURE_ORIGIN__}/__joint/seen-status`)).json())) {
    if (Date.now() > deadline) throw new Error('Browser request never reached server');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort();
  let aborted = false;
  try {
    await pending;
  } catch {
    aborted = true;
  }
  if (!aborted) throw new Error('Browser cancellation failed');
  await fetch(`${__FIXTURE_ORIGIN__}/__joint/session`, { credentials: 'include' });
  const sessionClient = createPolicyClient(executor, {
    policies: {
      'accounts.get': policy,
      'accounts.create': policy,
      'accounts.delete': policy,
      'public.status': policy,
      'session.me': { ...policy, authentication: 'required', refreshAuthentication: true },
      'session.refresh': { ...policy, authentication: 'optional', safety: 'unsafe' },
      'session.sign-out': { ...policy, authentication: 'optional', safety: 'unsafe' },
    },
    credentials: {
      kind: 'cookie',
      refresh: request => {
        if (!auth.credential.refresh) throw new Error('Refresh unavailable');
        return auth.credential.refresh(request);
      },
    },
  });
  const auth: OperationSessionAuthAdapter<FixtureContract> = new OperationSessionAuthAdapter({
    client: sessionClient,
    operations: {
      me: { operation: 'session.me', input: () => ({ headers: {} }) },
      refresh: { operation: 'session.refresh', input: () => ({ headers: {} }) },
      signOut: { operation: 'session.sign-out', input: () => ({ headers: {} }) },
    },
    mapUser: value => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('id' in value) ||
        typeof value.id !== 'string' ||
        !('email' in value) ||
        typeof value.email !== 'string'
      )
        throw new Error('Invalid identity');
      return { uid: value.id, email: value.email };
    },
  });
  await auth.initialize();
  if (auth.state().status !== 'authenticated') throw new Error('Browser refresh/replay failed');
  await auth.signOut();
  if (auth.state().status !== 'unauthenticated') throw new Error('Browser sign-out state failed');
  auth.destroy();
  return { calls: 5, cancellation: true, generatedForms: true, sessionRefreshReplay: true };
}
