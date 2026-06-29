// Dockview header「More actions」 → 选 Editor → 添加第二个 editor panel.
import { test, expect } from './fixtures/electron-app';
import { DOCK_CLOSE_EDITOR } from './helpers/editor';
import { EXPLORER_MORE_ACTIONS } from './helpers/explorer';
import { EDITOR_TAB } from './helpers/settings';

test('More actions menu → 选 Editor → 第二个 editor panel 添加', async ({
  window,
}) => {
  const moreBtn = window.getByRole('button', { name: EXPLORER_MORE_ACTIONS });
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  await moreBtn.click();

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();

  // 菜单含 Editor 选项
  await expect(menu.getByRole('menuitem', { name: EDITOR_TAB })).toBeVisible();
  await menu.getByRole('menuitem', { name: EDITOR_TAB }).click();
  await expect(menu).toBeHidden();

  // 添加后应有 2 个本地化 Editor close 按钮(每个 editor panel 自带 close)
  const closeBtns = window.getByRole('button', { name: DOCK_CLOSE_EDITOR });
  await expect(closeBtns).toHaveCount(2, { timeout: 5_000 });
});
