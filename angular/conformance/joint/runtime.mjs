import '@angular/compiler';
import assert from 'node:assert/strict';
import {
  Component,
  enableProdMode,
  Injector,
  inject,
  PendingTasks,
  PLATFORM_ID,
  provideZonelessChangeDetection,
  REQUEST,
  signal,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { renderApplication } from '@angular/platform-server';
import { OperationSessionAuthAdapter } from '@sixthsummit/ship-angular/auth';
import { createOperationForm } from '@sixthsummit/ship-angular/forms';
import {
  createPolicyClient,
  createShipClientToken,
  provideShipClient,
} from '@sixthsummit/ship-angular/operations';
import { createShipApiClientExecutor } from '@sixthsummit/ship-angular/ship-api';
import { createFixtureClient } from '@sixthsummit/ship-api-conformance-client';
import {
  accountFormBinding,
  clientContract,
  contractMetadata,
} from '@sixthsummit/ship-api-conformance-contract';
import { startFixture } from '@sixthsummit/ship-api-conformance-server';

const fixture = await startFixture();
const policies = Object.fromEntries(
  clientContract.operations.map(o => [
    o.id,
    {
      authentication: 'anonymous',
      safety: o.id === 'accounts.create' ? 'unsafe' : 'safe',
      idempotency: 'unsupported',
      replayable: true,
      transport: 'http',
    },
  ])
);
function create(context) {
  return createPolicyClient(
    createShipApiClientExecutor(clientContract, ({ credentials }) =>
      createFixtureClient({
        baseUrl: context.apiBaseUrl,
        headers: context.forwardedHeaders,
        credentials,
      })
    ),
    { policies, credentials: { kind: 'anonymous' }, signal: context.signal }
  );
}
try {
  const client = create({ apiBaseUrl: fixture.origin });
  const sessionClient = createPolicyClient(
    createShipApiClientExecutor(clientContract, ({ credentials }) =>
      createFixtureClient({
        baseUrl: fixture.origin,
        headers: { cookie: 'sid=node-fixture' },
        credentials,
      })
    ),
    {
      policies: {
        ...policies,
        'session.me': {
          ...policies['accounts.get'],
          authentication: 'required',
          refreshAuthentication: true,
        },
        'session.refresh': { ...policies['accounts.create'], authentication: 'optional' },
        'session.sign-out': { ...policies['accounts.create'], authentication: 'optional' },
      },
      credentials: { kind: 'cookie', refresh: request => auth.credential.refresh(request) },
    }
  );
  const auth = new OperationSessionAuthAdapter({
    client: sessionClient,
    operations: {
      me: { operation: 'session.me', input: () => ({ headers: {} }) },
      refresh: { operation: 'session.refresh', input: () => ({ headers: {} }) },
      signOut: { operation: 'session.sign-out', input: () => ({ headers: {} }) },
    },
    mapUser: value => ({ uid: value.id, email: value.email }),
  });
  await auth.initialize();
  assert.equal(auth.state().status, 'authenticated');
  assert.deepEqual(
    fixture.captures.filter(h => h.__path.startsWith('/session/')).map(h => h.__path),
    ['/session/me', '/session/refresh', '/session/me']
  );
  await auth.signOut();
  assert.equal(auth.state().status, 'unauthenticated');
  auth.destroy();
  const missing = await client.call('accounts.get', { params: { accountId: 'missing' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  assert.equal(missing.error.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(missing.error.details.extension, 'preserved');
  const read = await client.call('accounts.get', { params: { accountId: 'first' } });
  assert.equal(read.status, 200);
  assert.equal(read.data.id, 'first');
  assert.equal(read.headers.requestId, 'joint-request');
  const made = await client.call('accounts.create', { body: { name: 'Ada' } });
  assert.equal(made.status, 201);
  assert.equal(made.data.name, 'Ada');
  const deleted = await client.call('accounts.delete', { params: { accountId: 'first' } });
  assert.equal(deleted.status, 204);
  assert.equal(deleted.data, undefined);
  const invalid = await client.call('accounts.create', { body: { name: '' } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'VALIDATION_ERROR');
  assert.ok(invalid.error.details.issues.length);
  const form = createOperationForm(accountFormBinding);
  assert.deepEqual(form.body(), { name: '' });
  form.form.controls.name.setValue('Ada');
  form.include('note');
  form.include('enabled');
  assert.deepEqual(form.body(), { name: 'Ada', note: null, enabled: false });
  form.omit('note');
  assert.equal(Object.hasOwn(form.body(), 'note'), false);
  form.destroy();
  const token = createShipClientToken();
  const a = new globalThis.AbortController();
  const b = new globalThis.AbortController();
  function injector(user, controller) {
    return Injector.create({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        {
          provide: REQUEST,
          useValue: new globalThis.Request('https://frontend.test', {
            headers: {
              cookie: `session=${user}; private=never`,
              'x-request-id': user,
              'accept-language': user,
            },
            signal: controller.signal,
          }),
        },
        provideShipClient(token, create, {
          apiBaseUrl: fixture.origin,
          forwarding: {
            cookieNames: ['session'],
            headerNames: ['x-request-id', 'accept-language'],
          },
        }),
      ],
    });
  }
  const ia = injector('A', a),
    ib = injector('B', b);
  const ca = ia.get(token),
    cb = ib.get(token);
  assert.notEqual(ca, cb);
  await Promise.all([
    ca.call('accounts.get', { params: { accountId: 'A' } }),
    cb.call('accounts.get', { params: { accountId: 'B' } }),
  ]);
  for (const user of ['A', 'B']) {
    const capture = fixture.captures.find(h => h['x-request-id'] === user);
    assert.equal(capture.cookie, `session=${user}`);
    assert.equal(capture['accept-language'], user);
  }
  const abandoned = ca.call('public.status', { query: { delayMs: 100 } });
  const abortAssertion = assert.rejects(abandoned);
  const deadline = Date.now() + 3000;
  while (!fixture.captures.some(h => h['x-request-id'] === 'A' && h.__path.startsWith('/status'))) {
    if (Date.now() > deadline) throw new Error('SSR call never reached I/O');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  a.abort();
  await abortAssertion;
  assert.equal((await cb.call('public.status', { query: {} })).ok, true);
  ia.destroy();
  ib.destroy();
  enableProdMode();
  let started = 0;
  let release;
  const overlap = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Overlapping SSR renders did not both start')),
      10000
    );
    release = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const renderErrors = [];
  class JointRender {
    value = signal('pending');
    client = inject(token);
    request = inject(REQUEST);
    task = inject(PendingTasks).run(async () => {
      started += 1;
      if (started === 2) release();
      try {
        await overlap;
        const user = this.request.headers.get('x-request-id');
        const result = await this.client.call('accounts.get', { params: { accountId: user } });
        if (!result.ok) throw new Error('SSR result failed');
        this.value.set(result.data.id);
      } catch (error) {
        renderErrors.push(error);
      }
    });
  }
  Component({ selector: 'joint-render', standalone: true, template: '<p>{{value()}}</p>' })(
    JointRender
  );
  function render(user) {
    const request = new globalThis.Request('https://frontend.test', {
      headers: {
        'x-request-id': user,
        cookie: `session=${user};private=never`,
        'accept-language': user,
      },
    });
    return renderApplication(
      context =>
        bootstrapApplication(
          JointRender,
          {
            providers: [
              provideZonelessChangeDetection(),
              { provide: REQUEST, useValue: request },
              provideShipClient(token, create, {
                apiBaseUrl: fixture.origin,
                forwarding: {
                  cookieNames: ['session'],
                  headerNames: ['x-request-id', 'accept-language'],
                },
              }),
            ],
          },
          context
        ),
      {
        document: '<!doctype html><html><body><joint-render></joint-render></body></html>',
        url: 'https://frontend.test',
        allowedHosts: ['frontend.test'],
      }
    );
  }
  const rendered = await Promise.all([render('render-A'), render('render-B')]);
  assert.deepEqual(renderErrors, []);
  assert.equal(started, 2);
  assert.match(rendered[0], /<p>render-A<\/p>/);
  assert.doesNotMatch(rendered[0], /render-B/);
  assert.match(rendered[1], /<p>render-B<\/p>/);
  assert.doesNotMatch(rendered[1], /render-A/);
  for (const user of ['render-A', 'render-B']) {
    const capture = fixture.captures.find(h => h['x-request-id'] === user);
    assert.equal(capture.cookie, `session=${user}`);
    assert.equal(capture['accept-language'], user);
  }
  console.log(
    JSON.stringify({
      fixtureProtocolVersion: 1,
      graphHash: contractMetadata.graphHash,
      report: {
        calls: 5,
        primitiveForms: true,
        concurrentSsr: true,
        overlappingSsrDocuments: true,
        sessionRefreshReplay: true,
        cancellation: true,
      },
    })
  );
} finally {
  await fixture.close();
}
