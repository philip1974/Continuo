// Dockview group header 「打开视图…」菜单 → 列出 panel 类型 → 点击 addPanel.
import { test, expect } from './fixtures/with-workspace';
import { DOCK_POPOUT, TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';

test('点 「打开视图…」 → 菜单列出 panel 类型 + 点 Terminal 添加 panel', async ({
  window,
}) => {
  // HeaderActions 「打开视图…」按钮(aria-label = title)
  const moreBtn = dockHeaderMoreActionsButton(window);
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  await moreBtn.click();

  // role=menu 出现,内含 panel 类型(editor / terminal / settings 等)
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: TERMINAL_TAB })).toBeVisible();

  // 点 Terminal → addPanel + 关菜单 + Terminal panel 出现
  await menu.getByRole('menuitem', { name: TERMINAL_TAB }).click();
  await expect(menu).toBeHidden();
  await expect(
    window.getByRole('textbox', { name: TERMINAL_INPUT }),
  ).toBeVisible({ timeout: 15_000 });
});

test('文档 pointerdown 在 menu 外 → 关菜单', async ({ window }) => {
  const moreBtn = dockHeaderMoreActionsButton(window);
  await moreBtn.click();
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();

  // 点 footer(menu 外)关菜单
  await window.locator('footer').click({ force: true });
  await expect(menu).toBeHidden();
});

// VSCode:菜单开着时点菜单外任何位置(含相邻工具栏按钮)都先关菜单。此前整个 header 被当作菜单「内部」,
// 点同组「弹出到独立窗口」后面板弹走、菜单留在主窗。
test('菜单开着时点同组「弹出到独立窗口」→ 菜单关闭,面板弹出', async ({ electronApp, window }) => {
  const moreBtn = dockHeaderMoreActionsButton(window);
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  // 同一 header 工具栏里的弹出按钮(与「⋯」同父容器)
  const popoutBtn = moreBtn.locator('..').getByRole('button', { name: DOCK_POPOUT });
  await expect(popoutBtn).toBeEnabled({ timeout: 10_000 });
  await moreBtn.click();
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();

  await popoutBtn.click();
  await expect(menu).toBeHidden();
  await expect.poll(() => electronApp.windows().length).toBeGreaterThan(1);
  await expect(window.getByRole('menu')).toHaveCount(0);
});
