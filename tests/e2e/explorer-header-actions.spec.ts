// ExplorerHeader 顶栏 hover 工具条 + ⋯ 菜单的「展开全部 / 关闭文件夹」.
import { test, expect } from './fixtures/with-workspace';

test('hover header → 显新建文件 / 新建文件夹 / 刷新 / 折叠全部 4 个 IconButton', async ({
  window,
}) => {
  const aside = window.locator('main aside').nth(1);
  // hover header 让浮现工具条 — playwright hover 触发 group-hover
  await aside.locator('div.group').first().hover();

  await expect(
    aside.locator('button[aria-label="新建文件"]'),
  ).toBeVisible({ timeout: 5_000 });
  await expect(aside.locator('button[aria-label="新建文件夹"]')).toBeVisible();
  await expect(aside.locator('button[aria-label="刷新"]')).toBeVisible();
  await expect(aside.locator('button[aria-label="折叠全部"]')).toBeVisible();
});

test('⋯ 菜单可 toggle:再点 ⋯ 关菜单', async ({ window }) => {
  const moreBtn = window.locator('button[aria-label=更多操作]');
  await moreBtn.click();
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();
  // 「展开全部」存在(prop 注入),不点它(避免大量 DOM 更新打 race)
  await expect(
    menu.getByRole('menuitem', { name: /展开全部/ }),
  ).toBeVisible();
  // 再点 ⋯ 关菜单
  await moreBtn.click();
  await expect(menu).toBeHidden();
});

test('点 ⋯ → 关闭文件夹 → 退回 EmptyWorkspace', async ({ window }) => {
  await window.locator('button[aria-label=更多操作]').click();
  await window
    .getByRole('menu')
    .getByRole('menuitem', { name: /关闭文件夹/ })
    .click();

  await expect(window.locator('text=未打开文件夹')).toBeVisible({
    timeout: 5_000,
  });
});
