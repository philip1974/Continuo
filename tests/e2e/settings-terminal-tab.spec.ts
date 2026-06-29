// Settings 终端 tab 含字号 + 光标样式 + id chip.
import { test, expect } from './fixtures/electron-app';
import {
  CURSOR_STYLE_SETTING,
  FONT_SIZE_SETTING,
  SETTINGS,
  SETTINGS_NAV,
  TERMINAL_TAB,
} from './helpers/settings';

test('终端 tab 显字号(terminal.fontSize)+ 光标样式(terminal.cursorStyle)', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: TERMINAL_TAB })
    .click();

  const main = window.locator('main');
  await expect(window.getByText(FONT_SIZE_SETTING).first()).toBeVisible();
  await expect(window.getByText(CURSOR_STYLE_SETTING)).toBeVisible();
  await expect(
    main.locator('code').filter({ hasText: 'terminal.fontSize' }),
  ).toBeVisible();
  await expect(
    main.locator('code').filter({ hasText: 'terminal.cursorStyle' }),
  ).toBeVisible();
});
