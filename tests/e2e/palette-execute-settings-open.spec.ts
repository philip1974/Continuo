// CommandPalette 选择 settings.toggle 命令 → Settings panel 出.
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  settingsCommandOption,
} from './helpers/palette';
import { SETTINGS_NAV } from './helpers/settings';

test('Cmd+Shift+P → 选择 Settings 命令 → Settings nav 出', async ({
  window,
}) => {
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();
  const option = settingsCommandOption(window);
  await expect(option).toBeVisible();

  await option.click();
  await expect(input).toBeHidden({ timeout: 5_000 });

  // Settings nav
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toBeVisible({ timeout: 5_000 });
});
