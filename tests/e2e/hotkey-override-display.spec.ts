// 改 settings.toggle hotkey override → CommandPalette 列表中的 hotkey 后缀同步更新.
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  filterToSettingsCommand,
} from './helpers/palette';
import { waitForTestHooks } from './helpers/app-ready';

test('改 settings.toggle hotkey override → CommandPalette 显示新 hotkey', async ({
  window,
}) => {
  await waitForTestHooks(window);

  // override settings.toggle 的 hotkey 为 mod+shift+y
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setHotkey('settings.toggle', 'mod+shift+y');
  });

  // 打开命令面板
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();

  // 该项含 KeyCap Y(新 hotkey 的 key 部分)
  const item = await filterToSettingsCommand(window);
  await expect(item).toBeVisible();
  // 'mod+shift+y' 切片含 'Y' 字符 — 用 textContent 验证
  const text = await item.textContent();
  expect(text).toMatch(/Y/i);
  // 不再含旧 hotkey ',' 的 KeyCap('settings.toggle' default 是 'mod+,')
  const keycaps = await item.locator('kbd').allTextContents();
  expect(keycaps.length).toBeGreaterThan(0);
  expect(keycaps.join('')).not.toContain(',');
});
