// Settings 终端 tab 含字号 + 光标样式 + id chip.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV, TERMINAL_TAB } from './helpers/settings';

test('终端 tab 显字号(terminal.fontSize)+ 光标样式(terminal.cursorStyle)', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: TERMINAL_TAB })
    .click();

  const main = window.locator('main');
  await expect(main).toContainText('字号');
  await expect(main).toContainText('光标样式');
  await expect(
    main.locator('code').filter({ hasText: 'terminal.fontSize' }),
  ).toBeVisible();
  await expect(
    main.locator('code').filter({ hasText: 'terminal.cursorStyle' }),
  ).toBeVisible();
});
