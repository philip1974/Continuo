// Dockview header「More actions」 → 选 Editor → 添加第二个 editor panel.
import { test, expect } from './fixtures/electron-app';

test('More actions menu → 选 Editor → 第二个 editor panel 添加', async ({
  window,
}) => {
  const moreBtn = window.locator('button[aria-label="More actions"]');
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  await moreBtn.click();

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();

  // 菜单含 Editor 选项
  await expect(menu).toContainText('Editor');
  await menu.getByRole('menuitem', { name: 'Editor', exact: true }).click();
  await expect(menu).toBeHidden();

  // 添加后应有 2 个 'Close Editor' 按钮(每个 editor panel 自带 close)
  const closeBtns = window.locator('button[aria-label="Close Editor"]');
  await expect(closeBtns).toHaveCount(2, { timeout: 5_000 });
});
