// Dockview group header 「更多操作」菜单 → 列出 panel 类型 → 点击 addPanel.
import { test, expect } from './fixtures/with-workspace';
import { TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';

test('点 「更多操作」 → 菜单列出 panel 类型 + 点 Terminal 添加 panel', async ({
  window,
}) => {
  // HeaderActions 「More actions」按钮 aria-label="More actions"
  const moreBtn = dockHeaderMoreActionsButton(window);
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  await moreBtn.click();

  // role=menu 出现,内含 panel 类型(editor / terminal / settings 等)
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: TERMINAL_TAB })).toBeVisible();

  // 点 Terminal → addPanel + 关菜单 + TerminalTabs 出现
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
