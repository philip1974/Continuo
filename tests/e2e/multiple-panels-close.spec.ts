// 加 Terminal 和 Settings 后,选择性关闭一个 → 另两个仍在.
import { test, expect } from './fixtures/with-workspace';
import {
  DOCK_CLOSE_EDITOR,
  DOCK_CLOSE_TERMINAL,
  TERMINAL_INPUT,
} from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import {
  CLOSE_SETTINGS,
  SETTINGS,
  SETTINGS_NAV,
  TERMINAL_TAB,
} from './helpers/settings';

test('开 Editor + Terminal + Settings → 关 Settings → Editor + Terminal 仍在', async ({
  window,
}) => {
  // 加 Terminal
  await dockHeaderMoreActionsButton(window).click();
  await window
    .getByRole('menu')
    .last()
    .getByRole('menuitem', { name: TERMINAL_TAB })
    .click();
  await expect(
    window.getByRole('textbox', { name: TERMINAL_INPUT }),
  ).toBeVisible({ timeout: 10_000 });

  // 加 Settings
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });

  // 关 Settings
  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await window.waitForTimeout(400);

  // Editor SharedTab close + Terminal SharedTab close 仍在
  await expect(window.getByRole('button', { name: DOCK_CLOSE_EDITOR })).toHaveCount(
    1,
  );
  await expect(
    window.getByRole('button', { name: DOCK_CLOSE_TERMINAL }),
  ).toHaveCount(1);
  // Settings 没了
  await expect(
    window.getByRole('button', { name: CLOSE_SETTINGS }),
  ).toHaveCount(0);
});
