// ExplorerHeader ⋯ 菜单 / HeaderActions 「更多操作」菜单 / 各 ContextMenu 的
// 「点击外部关闭」一致性 smoke.
import { test, expect } from './fixtures/with-workspace';
import { explorerMoreActionsButton } from './helpers/explorer';

test('ExplorerHeader ⋯ 菜单 → 点 main 区域 → 菜单关', async ({ window }) => {
  await explorerMoreActionsButton(window).click();
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();

  // 点 dock 主区域
  await window.locator('header').first().click();
  await expect(menu).toBeHidden();
});

test('右键 README.md ContextMenu → Esc → 菜单关', async ({ window }) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});
