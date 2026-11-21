// dockview HeaderActions 「+」菜单连续添加多个 panel.
//
// editor 默认在;通过菜单加 Terminal + Settings,3 个 panel 共存.
import { test, expect } from './fixtures/with-workspace';
import { DOCK_CLOSE_BUTTON, TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';

test('添加 Terminal panel → dock 含 Editor + Terminal 两个', async ({
  window,
}) => {
  await dockHeaderMoreActionsButton(window).click();
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: TERMINAL_TAB }).click();
  await expect(
    window.getByRole('textbox', { name: TERMINAL_INPUT }),
  ).toBeVisible({ timeout: 15_000 });

  // Close 按钮 ≥ 2:
  //   - Editor SharedTab close
  //   - Terminal SharedTab close
  //   - 终端内单 session 的 TabNavItem close('Close ${title}')
  // 至少 2 个 panel 级 close 存在
  const closeBtns = await window
    .getByRole('button', { name: DOCK_CLOSE_BUTTON })
    .count();
  expect(closeBtns).toBeGreaterThanOrEqual(2);
});
