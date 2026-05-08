// CommandPalette 列表项右侧显示 hotkey 后缀(KeyCap 切片).
import { test, expect } from './fixtures/electron-app';

test('settings.open 行右侧显示 ⌘, hotkey 切片', async ({ window }) => {
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();

  await input.fill('Settings');
  // 第一项匹配 settings.open(category=Settings)
  const firstLi = window.locator('.wm-modal-content li').first();
  await expect(firstLi).toBeVisible();

  // KeyCap 切片(formatHotkeyParts):mac 平台 ⌘ + ',';others Ctrl + ','
  // 不 platform-assume,只验证有 KeyCap kbd 元素
  const kbds = firstLi.locator('kbd.wm-keycap');
  expect(await kbds.count()).toBeGreaterThan(0);
});
