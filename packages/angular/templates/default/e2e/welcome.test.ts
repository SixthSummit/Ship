import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('welcome scaffold', () => {
  test('renders the welcome page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /welcome to shipangular/i })).toBeVisible();
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    await page.goto('/');
    await expectNoA11yViolations(page, 'welcome');
  });
});
