// Quick Open 打开后按 ESC → modal 关闭.
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  openQuickOpen,
  quickOpenInput,
} from './helpers/palette';

test('Ctrl+P 打开 → ESC → modal 关闭', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden({ timeout: 5_000 });
});

test('Ctrl+Shift+P 打开命令面板 → ESC → modal 关闭', async ({ window }) => {
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden({ timeout: 5_000 });
});
