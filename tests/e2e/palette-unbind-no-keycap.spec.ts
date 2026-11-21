// override settings.toggle 为空字符串(unbind)→ palette 该项不显 KeyCap.
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  settingsCommandOption,
} from './helpers/palette';

test('unbind settings.toggle → palette 该项无 KeyCap', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 先打开 palette,验证默认有 KeyCap
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();
  const item = settingsCommandOption(window);
  await expect(item).toBeVisible();
  expect(await item.locator('kbd.wm-keycap').count()).toBeGreaterThan(0);

  // 关 + unbind
  await window.keyboard.press('Escape');
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.toggle', ''); // unbind
  });

  // 重开 palette
  await openCommandPalette(window);
  const input2 = commandPaletteInput(window);
  await expect(input2).toBeVisible();
  const item2 = settingsCommandOption(window);
  await expect(item2).toBeVisible();

  // 应不显 KeyCap
  expect(await item2.locator('kbd.wm-keycap').count()).toBe(0);
});
