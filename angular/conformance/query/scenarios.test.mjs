import { describe, expect, it } from 'vitest';
import { referenceAdapter } from './reference-adapter.mjs';
import { queryScenarios, runQueryConformance } from './scenarios.mjs';

describe('query scenario assertion sensitivity (fixture-only)', () => {
  it('runs every scenario with no skips against the reference fixture', async () => {
    const report = await runQueryConformance(referenceAdapter(), { kind: 'reference' });
    expect(report.passed).toEqual(Object.keys(queryScenarios));
    expect(report.skipped).toEqual([]);
    expect(report.acceptance).toBe('fixture-only');
  });
  it.each([
    ['results', 'results', 'declared failure remains lossless'],
    ['etag', 'etag', '304 retains'],
    ['deduplication', 'deduplication', 'one transport call'],
    ['invalidation', 'invalidation', 'exact invalidation'],
    ['pagination', 'pagination', 'page parameters'],
    ['scope', 'scope', 'before framework tick'],
    ['rollback', 'rollback', 'one rollback'],
    ['mutationScope', 'late-callback', 'late success callback'],
    ['retry', 'retry', 'policy retry exhaustion'],
    ['ssr', 'ssr', 'distinct native QueryClients'],
  ])('fails %s for seeded defect %s', async (scenario, defect, message) => {
    await expect(queryScenarios[scenario](referenceAdapter(defect))).rejects.toThrow(message);
  });
  it('can select scenarios without calling a different adapter implementation', async () => {
    const report = await runQueryConformance(referenceAdapter(), { only: ['etag'] });
    expect(report.passed).toEqual(['etag']);
    expect(report.acceptance).toBe('partial-scenarios');
    expect(report.skipped).toHaveLength(9);
  });
});
