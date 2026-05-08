// copy + paste → clipboard 保留 → 再右键仍含「粘贴」.
import { test, expect } from './fixtures/with-workspace';

test('copy README → paste → 再右键 → 「粘贴」 仍显', async ({ window }) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^复制$/ }).click();

  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();
  await window.waitForTimeout(300);

  // 再右键 src → 「粘贴」 仍显
  await window.locator('text=src').first().click({ button: 'right' });
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('粘贴');
});
