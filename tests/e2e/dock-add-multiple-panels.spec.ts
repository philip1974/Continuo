// dockview HeaderActions 「+」菜单连续添加多个 panel.
//
// editor 默认在;通过菜单加 Terminal + Settings,3 个 panel 共存.
import { test, expect } from './fixtures/electron-app';

test('添加 Terminal panel → dock 含 Editor + Terminal 两个', async ({
  window,
}) => {
  await window.locator('button[aria-label="More actions"]').click();
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
  await expect(
    window.locator('button[aria-label="新建终端"]'),
  ).toBeVisible({ timeout: 15_000 });

  // Close 按钮 ≥ 2:
  //   - Editor SharedTab close
  //   - Terminal SharedTab close
  //   - 终端内单 session 的 TabNavItem close('Close ${title}')
  // 至少 2 个 panel 级 close 存在
  const closeBtns = await window
    .locator('button[aria-label^="Close"]')
    .count();
  expect(closeBtns).toBeGreaterThanOrEqual(2);
});
