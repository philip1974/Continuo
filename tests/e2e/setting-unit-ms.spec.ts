// autoSave.delayMs 行 unit 'ms'.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, openSettingsTab } from './helpers/settings';

test('编辑器 tab → autoSave delay 行 unit 显「ms」', async ({ window }) => {
  await openSettingsTab(window, EDITOR_TAB);

  const main = window.locator('main');
  const msChip = main
    .locator('span.uppercase')
    .filter({ hasText: /^ms$/i })
    .first();
  await expect(msChip).toBeVisible();
});
