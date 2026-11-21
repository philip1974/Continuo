// Modal data-size 属性:CommandPalette=md,QuickOpen=lg.
import { test, expect } from './fixtures/electron-app';
import { openCommandPalette, openQuickOpen } from './helpers/palette';

test('CommandPalette modal data-size=md', async ({ window }) => {
  await openCommandPalette(window);
  const content = window.locator('.wm-modal-content');
  await expect(content).toBeVisible();
  await expect(content).toHaveAttribute('data-size', 'md');
});

test('QuickOpen modal data-size=lg', async ({ window }) => {
  await openQuickOpen(window);
  const content = window.locator('.wm-modal-content');
  await expect(content).toBeVisible();
  await expect(content).toHaveAttribute('data-size', 'lg');
});
