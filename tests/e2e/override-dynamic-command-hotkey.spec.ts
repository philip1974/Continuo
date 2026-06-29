// 动态命令 hotkey override → palette 显新组合(KeyCap 反映 override).
import { test, expect } from './fixtures/electron-app';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';

test('register + setHotkey override → palette 显示新 hotkey', async ({ window }) => {
  await window.waitForFunction(
    () => Boolean((window as unknown as { __continuoTest?: unknown }).__continuoTest),
    { timeout: 5_000 },
  );

  // 注册带初始 hotkey 命令
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (id: string, title: string, hotkey?: string) => () => void;
          setHotkey: (id: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.dyn-override', 'DynOverride', 'mod+shift+x');
    // override 为 mod+shift+z
    t.setHotkey('e2e.dyn-override', 'mod+shift+z');
  });

  // 打开 palette → 搜命令
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await input.fill('DynOverride');
  const item = window.locator('.wm-modal-content li').first();
  await expect(item).toContainText('DynOverride');

  // KeyCap 应含 'Z'(override 后)而非 'X'(原)
  const kbds = item.locator('kbd.wm-keycap');
  expect(await kbds.count()).toBeGreaterThan(0);
  const kbdsText = (await kbds.allTextContents()).join('|');
  expect(kbdsText.toLowerCase()).toContain('z');
  expect(kbdsText.toLowerCase()).not.toContain('x');
});
