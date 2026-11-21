// Modal Tab 键不离开 modal,且 modal 仍开.
import { test, expect } from './fixtures/electron-app';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';

test('CommandPalette 开 → Tab → modal 仍开', async ({ window }) => {
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();

  // 多按几次 Tab,modal 仍开
  await window.keyboard.press('Tab');
  await window.keyboard.press('Tab');
  await window.keyboard.press('Tab');
  await expect(input).toBeVisible();
});
