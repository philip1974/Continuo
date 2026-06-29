// Settings panel 在 dock 内 + Cmd+Shift+P → palette modal 显示在 settings 之上.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';

test('Settings open + Cmd+Shift+P → palette 显 + Settings nav 仍在', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible({ timeout: 5_000 });

  // Settings nav 仍存在 (dock panel,不会因 modal 关闭)
  await expect(nav).toBeVisible();
});
