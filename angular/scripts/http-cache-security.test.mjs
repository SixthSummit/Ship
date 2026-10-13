import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve('astro', { paths: ['../apps/angular-docs'] }));
const CachePolicy = astroRequire('http-cache-semantics');
const request = { url: 'https://example.test/account', method: 'GET', headers: {} };
const staleRequest = { ...request, headers: { 'cache-control': 'max-stale=999999' } };
const policy = (headers, shared = true) =>
  new CachePolicy(request, { status: 200, headers }, { shared });

for (const [name, headers] of [
  ['shared cookie without public', { 'set-cookie': 'session=fixture' }],
  ['response no-cache', { 'cache-control': 'no-cache' }],
  ['shared proxy-revalidate', { 'cache-control': 'proxy-revalidate' }],
]) {
  test(`${name} cannot become reusable through max-stale`, () => {
    const cached = policy(headers);
    assert.equal(
      cached.storable(),
      true,
      'This reproduces a valid stored entry, not caller misuse'
    );
    assert.equal(cached.maxAge(), 0);
    assert.equal(cached.satisfiesWithoutRevalidation(staleRequest), false);
    assert.equal(cached.evaluateRequest(staleRequest).response, undefined);
  });
}
for (const directive of ['private', 'no-store']) {
  test(`${directive} is not storable in a shared cache`, () => {
    assert.equal(policy({ 'cache-control': directive }).storable(), false);
  });
}
test('ordinary public expiry still permits bounded max-stale', () => {
  const cached = policy({ 'cache-control': 'public, max-age=1', age: '10' });
  assert.equal(cached.satisfiesWithoutRevalidation(staleRequest), true);
  assert.equal(
    cached.satisfiesWithoutRevalidation({
      ...request,
      headers: { 'cache-control': 'max-stale=2' },
    }),
    false
  );
});
test('explicitly public cookies and private-cache cookies remain reusable', () => {
  assert.equal(
    policy({
      'set-cookie': 'session=fixture',
      'cache-control': 'public, max-age=1',
      age: '10',
    }).satisfiesWithoutRevalidation(staleRequest),
    true
  );
  assert.equal(
    policy(
      { 'set-cookie': 'session=fixture', 'cache-control': 'max-age=1', age: '10' },
      false
    ).satisfiesWithoutRevalidation(staleRequest),
    true
  );
});
test('must-revalidate still prohibits stale reuse', () => {
  assert.equal(
    policy({
      'cache-control': 'must-revalidate, max-age=1',
      age: '10',
    }).satisfiesWithoutRevalidation(staleRequest),
    false
  );
});
test('ordinary stale-if-error still retains its policy on server failure', () => {
  const cached = policy({ 'cache-control': 'public, max-age=1, stale-if-error=60', age: '10' });
  const revalidated = cached.revalidatedPolicy(request, { status: 503, headers: {} });
  assert.equal(revalidated.policy, cached);
  assert.equal(revalidated.modified, false);
});

test('ordinary max-age=0 is eligible for explicit max-stale', () => {
  assert.equal(
    policy({ 'cache-control': 'public, max-age=0' }).satisfiesWithoutRevalidation(staleRequest),
    true
  );
});
test('immutable cookie opt-in and private proxy-revalidate keep existing policy semantics', () => {
  assert.equal(
    policy({
      'set-cookie': 'session=fixture',
      'cache-control': 'immutable, max-age=0',
    }).satisfiesWithoutRevalidation(staleRequest),
    true
  );
  assert.equal(
    policy({ 'cache-control': 'proxy-revalidate, max-age=0' }, false).satisfiesWithoutRevalidation(
      staleRequest
    ),
    true
  );
});
