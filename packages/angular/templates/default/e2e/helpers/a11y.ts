import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Run axe-core against the current page and assert there are no
 * serious or critical accessibility violations. Less-severe issues
 * (minor / moderate) are reported as test annotations but don't fail.
 *
 * Phase 1b's tripwire scope. Phase 6 expands a11y coverage and lowers the
 * threshold to "no violations of any severity."
 */
export async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const fatal = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
  if (fatal.length > 0) {
    const summary = fatal
      .map(v => `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
      .join('\n');
    throw new Error(`a11y: ${fatal.length} serious/critical violation(s) on ${label}:\n${summary}`);
  }
  // Surface less-severe issues as a soft note for the test report.
  expect(fatal.length).toBe(0);
}
