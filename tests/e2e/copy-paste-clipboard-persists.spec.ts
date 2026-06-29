// copy + paste → clipboard 保留 → 再右键仍含「粘贴」.
import { test, expect } from './fixtures/with-workspace';

const COPY = /^(复制|Copy|복사)$/;
const PASTE = /^(粘贴|Paste|붙여넣기)$/;

test('copy README → paste → 再右键 → 「粘贴」 仍显', async ({ window }) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: COPY }).click();

  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: PASTE }).click();
  await window.waitForTimeout(300);

  // 再右键 src → 「粘贴」 仍显
  await window.locator('text=src').first().click({ button: 'right' });
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: PASTE })).toBeVisible();
});
