// autoSave.delayMs 行 unit 'ms'.
import { test, expect } from './fixtures/electron-app';

test('编辑器 tab → autoSave delay 行 unit 显「ms」', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  const main = window.locator('main');
  const msChip = main
    .locator('span.uppercase')
    .filter({ hasText: /^ms$/i })
    .first();
  await expect(msChip).toBeVisible();
});
