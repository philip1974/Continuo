// 关命令面板再打开 → query 重置为空.
import { test, expect } from './fixtures/electron-app';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';

test('palette 输 X → ESC → 重开 → input 为空', async ({ window }) => {
  await openCommandPalette(window);
  let input = commandPaletteInput(window);
  await expect(input).toBeVisible();
  await input.fill('something');
  await expect(input).toHaveValue('something');

  // ESC
  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();

  // 再开
  await openCommandPalette(window);
  input = commandPaletteInput(window);
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toHaveValue('');
});
