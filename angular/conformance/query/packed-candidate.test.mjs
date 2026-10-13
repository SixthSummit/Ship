import { expect, it } from 'vitest';
import { createQueryAdapter } from './candidate.mjs';
import { runCandidateSsrStability } from './candidate-ssr-checks.mjs';
import { runQueryConformance } from './scenarios.mjs';

it('drives all real public package scenarios through the physical archive', async () => {
  const report = await runQueryConformance(createQueryAdapter);
  expect(report.passed).toHaveLength(10);
  expect(report.skipped).toEqual([]);
});
it('holds and releases real request PendingTasks across every operation outcome', async () => {
  const report = await runCandidateSsrStability();
  expect(report.passed).toEqual([
    'success',
    'failure',
    'exception',
    'retry',
    'abort',
    'trackPendingTasks:false',
  ]);
  expect(report.skipped).toEqual([]);
});

import { runCandidateWire } from './candidate-wire.mjs';
import { createCandidateWireServer } from './candidate-wire-server.mjs';

it('drives the packed query through actual HTTP results and cancellation', async () => {
  const fixture = await createCandidateWireServer();
  try {
    const report = await runCandidateWire(createQueryAdapter, fixture.control, fixture.origin);
    expect(report.requests).toBe(3);
    expect(report.passed).toHaveLength(4);
    await expect(fixture.control('invalid')).rejects.toThrow('Unknown wire control');
  } finally {
    await fixture.close();
  }
});
