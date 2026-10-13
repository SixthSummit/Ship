import { describe, expect, it } from 'vitest';
import type { OperationDefinition } from '../../../operations/src/operation-contract';
import { canonicalizeKeyValue } from './canonicalize-key-value';
import { createShipQueryKey } from './create-ship-query-key';
import type { ShipQueryKeyValue, ShipQueryScopeSnapshot } from './ship-query-key';
import { assertShipReadBinding, defineShipReadBinding } from './ship-read-binding';

type Contract = {
  list: OperationDefinition<{ query: { page: number; filter: string } }, { 200: string[] }>;
};
const scope: ShipQueryScopeSnapshot = {
  namespace: 'inventory@1',
  scopeKey: 'user:1/tenant:1',
  generation: 0,
};
const binding = defineShipReadBinding<Contract>()({
  operationId: 'list',
  safety: 'safe',
  inputKey: input => input.query,
  variantKey: { locale: 'en' },
});
const input = { query: { page: 1, filter: 'available' } };

describe('createShipQueryKey', () => {
  it('uses the required tuple and canonical object ordering', () => {
    const key = createShipQueryKey(binding, input, scope, 'finite');
    expect(key).toEqual([
      'ship-query',
      1,
      'inventory@1',
      'user:1/tenant:1',
      0,
      'finite',
      'list',
      { locale: 'en' },
      { filter: 'available', page: 1 },
    ]);
    expect(JSON.stringify(key)).toBe(
      JSON.stringify(
        createShipQueryKey(binding, { query: { filter: 'available', page: 1 } }, scope, 'finite')
      )
    );
    expect(Object.keys(key[8] as object)).toEqual(['filter', 'page']);
  });

  it('separates each response and identity boundary', () => {
    const original = createShipQueryKey(binding, input, scope, 'finite');
    const others = [
      createShipQueryKey(binding, input, scope, 'infinite'),
      createShipQueryKey(binding, input, { ...scope, namespace: 'inventory@2' }, 'finite'),
      createShipQueryKey(binding, input, { ...scope, scopeKey: 'user:2/tenant:1' }, 'finite'),
      createShipQueryKey(binding, input, { ...scope, scopeKey: 'user:1/tenant:2' }, 'finite'),
      createShipQueryKey(binding, input, { ...scope, generation: 1 }, 'finite'),
      createShipQueryKey({ ...binding, variantKey: { locale: 'fr' } }, input, scope, 'finite'),
      createShipQueryKey(binding, { query: { ...input.query, page: 2 } }, scope, 'finite'),
    ];
    for (const other of others) expect(other).not.toEqual(original);
  });

  it('detaches and freezes keys instead of freezing application input', () => {
    const mutable = { query: { page: 3, filter: 'reserved' } };
    const key = createShipQueryKey(binding, mutable, scope, 'finite');
    mutable.query.page = 9;
    expect(key[8]).toEqual({ page: 3, filter: 'reserved' });
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.isFrozen(key[7])).toBe(true);
    expect(Object.isFrozen(key[8])).toBe(true);
    expect(Object.isFrozen(mutable.query)).toBe(false);
  });

  it.each([
    { ...scope, namespace: '' },
    { ...scope, scopeKey: '' },
    { ...scope, generation: -1 },
    { ...scope, generation: 0.5 },
    { ...scope, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...scope, generation: Number.NaN },
    undefined,
  ])('rejects an invalid scope %j', invalid => {
    expect(() => createShipQueryKey(binding, input, invalid as never, 'finite')).toThrow(TypeError);
  });

  it('rejects unsupported mode and invalid mapper output', () => {
    expect(() => createShipQueryKey(binding, input, scope, 'other' as never)).toThrow(TypeError);
    expect(() =>
      createShipQueryKey({ ...binding, inputKey: () => undefined as never }, input, scope, 'finite')
    ).toThrow(TypeError);
  });
});

describe('safe read bindings', () => {
  it('accepts a matching policy and snapshots the variant', () => {
    const variant = { locale: 'en' };
    const defined = defineShipReadBinding<Contract>()(
      { ...binding, variantKey: variant },
      {
        list: {
          safety: 'safe',
          authentication: 'required',
          idempotency: 'unsupported',
          replayable: true,
        },
      }
    );
    variant.locale = 'fr';
    expect(defined.variantKey).toEqual({ locale: 'en' });
    expect(Object.isFrozen(defined)).toBe(true);
  });

  it.each(['idempotent', 'unsafe'] as const)('rejects conflicting %s policy', safety => {
    expect(() =>
      assertShipReadBinding(binding, {
        list: {
          safety,
          authentication: 'required',
          idempotency: 'unsupported',
          replayable: true,
        },
      })
    ).toThrow('conflicts');
  });

  it.each([
    undefined,
    { ...binding, safety: 'unsafe' },
    { ...binding, safety: undefined },
    { ...binding, operationId: '' },
    { ...binding, operationId: 1 },
    { ...binding, inputKey: undefined },
  ])('rejects an invalid declaration %j', invalid => {
    expect(() => assertShipReadBinding(invalid as never)).toThrow(TypeError);
  });
});

describe('JSON key values', () => {
  it('preserves array order, accepts null prototypes, and preserves special property names', () => {
    const value = Object.create(null);
    Object.defineProperty(value, '__proto__', { value: [true, null, 'x'], enumerable: true });
    expect(JSON.stringify(canonicalizeKeyValue(value))).toBe('{"__proto__":[true,null,"x"]}');
    expect(canonicalizeKeyValue([2, 1])).toEqual([2, 1]);
    expect(canonicalizeKeyValue(-0)).toBe(0);
  });

  it('accepts shared acyclic children and copies each occurrence', () => {
    const child = { x: 1 };
    expect(canonicalizeKeyValue([child, child])).toEqual([{ x: 1 }, { x: 1 }]);
  });

  it.each([
    undefined,
    () => 1,
    Symbol('key'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(),
    new Map(),
    new Set(),
    [undefined],
    { a: undefined },
    new Array(1),
    Object.defineProperty({}, 'hidden', { value: 1 }),
    { [Symbol('key')]: 1 },
    Object.assign([1], { label: 'ignored' }),
    Object.assign([1], { 4294967295: 'ignored' }),
    Object.assign([1], { [Symbol('extra')]: 'ignored' }),
  ])('rejects values that cannot have lossless JSON keys', value => {
    expect(() => canonicalizeKeyValue(value)).toThrow(TypeError);
  });

  it('rejects cycles and accessors without executing getters', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => canonicalizeKeyValue(cyclic)).toThrow('cycles');
    let calls = 0;
    const getter = () => {
      calls++;
      return 1;
    };
    const object = Object.defineProperty({}, 'x', { enumerable: true, get: getter });
    const array = Object.defineProperty([1], '0', { enumerable: true, get: getter });
    expect(() => canonicalizeKeyValue(object)).toThrow(TypeError);
    expect(() => canonicalizeKeyValue(array)).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it('rejects unsupported response variant keys at definition time', () => {
    expect(() =>
      defineShipReadBinding<Contract>()({
        ...binding,
        variantKey: undefined as unknown as ShipQueryKeyValue,
      })
    ).toThrow(TypeError);
  });
});
