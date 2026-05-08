// Dockview group header 「更多操作」菜单 → 列出 panel 类型 → 点击 addPanel.
import { test, expect } from './fixtures/electron-app';

test('点 「更多操作」 → 菜单列出 panel 类型 + 点 Terminal 添加 panel', async ({
  window,
}) => {
  // HeaderActions 「More actions」按钮 aria-label="More actions"
  const moreBtn = window.locator('button[aria-label="More actions"]');
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  await moreBtn.click();

  // role=menu 出现,内含 panel 类型(editor / terminal / settings 等)
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Terminal');

  // 点 Terminal → addPanel + 关菜单 + TerminalTabs 出现
  await menu.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(
    window.locator('button[aria-label="新建终端"]'),
  ).toBeVisible({ timeout: 15_000 });
});

test('文档 pointerdown 在 menu 外 → 关菜单', async ({ window }) => {
  const moreBtn = window.locator('button[aria-label="More actions"]');
  await moreBtn.click();
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();

  // 点 footer(menu 外)关菜单
  await window.locator('footer').click({ force: true });
  await expect(menu).toBeHidden();
});
