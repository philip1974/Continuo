// Terminal Panel:通过 dock header 菜单创建 session,Terminal panel 渲染.
//
// node-pty 是 native module,e2e 跑构建出的 app 时 main 进程已 link 好。
// 这里只验证 UI 层:terminal panel 出现 + 再次创建会追加 panel.
//
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';

async function createTerminalSession(window: Page): Promise<void> {
  await dockHeaderMoreActionsButton(window).click();
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: TERMINAL_TAB }).click();
  await expect(menu).toBeHidden();
}

test('打开 Terminal panel → session panel 渲染', async ({
  window,
}) => {
  await createTerminalSession(window);

  await expect(
    window.getByRole('textbox', { name: TERMINAL_INPUT }),
  ).toBeVisible({ timeout: 15_000 });
});

test('再次选择 Terminal → 新建第二个 terminal session', async ({ window }) => {
  await createTerminalSession(window);
  await expect(
    window.getByRole('textbox', { name: TERMINAL_INPUT }),
  ).toBeVisible({ timeout: 15_000 });

  await createTerminalSession(window);

  await expect
    .poll(() =>
      window.getByRole('tab').filter({ hasText: TERMINAL_PANEL_TAB }).count(),
    )
    .toBeGreaterThanOrEqual(2);
});
