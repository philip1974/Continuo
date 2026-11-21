// ExplorerHeader 顶栏 hover 工具条 + ⋯ 菜单的「展开全部 / 关闭文件夹」.
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_CLOSE_FOLDER,
  EXPLORER_COLLAPSE_ALL,
  EXPLORER_EXPAND_ALL,
  EXPLORER_NEW_FILE,
  EXPLORER_NEW_FOLDER,
  EXPLORER_NO_FOLDER_OPEN,
  EXPLORER_REFRESH,
  explorerMoreActionsButton,
  explorerSidebar,
} from './helpers/explorer';

test('hover header → 显新建文件 / 新建文件夹 / 刷新 / 折叠全部 4 个 IconButton', async ({
  window,
}) => {
  const aside = explorerSidebar(window);
  // hover header 让浮现工具条 — playwright hover 触发 group-hover
  await aside.locator('div.group').first().hover();

  await expect(
    aside.getByRole('button', { name: EXPLORER_NEW_FILE }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    aside.getByRole('button', { name: EXPLORER_NEW_FOLDER }),
  ).toBeVisible();
  await expect(
    aside.getByRole('button', { name: EXPLORER_REFRESH }),
  ).toBeVisible();
  await expect(
    aside.getByRole('button', { name: EXPLORER_COLLAPSE_ALL }),
  ).toBeVisible();
});

test('⋯ 菜单可 toggle:再点 ⋯ 关菜单', async ({ window }) => {
  const moreBtn = explorerMoreActionsButton(window);
  await moreBtn.click();
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();
  // 「展开全部」存在(prop 注入),不点它(避免大量 DOM 更新打 race)
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_EXPAND_ALL }),
  ).toBeVisible();
  // 再点 ⋯ 关菜单
  await moreBtn.click();
  await expect(menu).toBeHidden();
});

test('点 ⋯ → 关闭文件夹 → 退回 EmptyWorkspace', async ({ window }) => {
  await explorerMoreActionsButton(window).click();
  await window
    .getByRole('menu')
    .getByRole('menuitem', { name: EXPLORER_CLOSE_FOLDER })
    .click();

  await expect(window.getByText(EXPLORER_NO_FOLDER_OPEN)).toBeVisible({
    timeout: 5_000,
  });
});
