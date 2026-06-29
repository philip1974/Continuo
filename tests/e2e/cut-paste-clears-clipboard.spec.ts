// cut + paste 后 → clipboard 自动清 → 再右键不显「粘贴」.
import { test, expect } from './fixtures/with-workspace';

const CUT = /^(剪切|Cut|잘라내기)$/;
const PASTE = /^(粘贴|Paste|붙여넣기)$/;

test('cut README → paste 到 src → 再右键 src → 不含「粘贴」', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: CUT }).click();

  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: PASTE }).click();

  // 等 paste 完成
  await window.waitForTimeout(300);

  // 再右键 src → 「粘贴」 不再显(clipboard 清)
  await window.locator('text=src').first().click({ button: 'right' });
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu).not.toContainText(PASTE);
});
