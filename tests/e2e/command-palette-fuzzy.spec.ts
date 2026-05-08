// CommandPalette fuzzy 匹配 — 大小写不敏感 + 跨字符匹配.
import { test, expect } from './fixtures/electron-app';

async function openPalette(window: import('@playwright/test').Page): Promise<void> {
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
}

test('小写 "settings" 也能匹配「Settings: 打开 Settings」', async ({
  window,
}) => {
  await expect(window.locator('button[title="设置"]')).toBeVisible({
    timeout: 10_000,
  });
  await openPalette(window);
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();

  await input.fill('settings');
  // 至少 1 项含 'Settings'
  const firstLi = window.locator('.wm-modal-content li').first();
  await expect(firstLi).toContainText('Settings');
});

test('跨字符模糊 "set" 匹配「Settings」', async ({ window }) => {
  await expect(window.locator('button[title="设置"]')).toBeVisible({
    timeout: 10_000,
  });
  await openPalette(window);
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await input.fill('set');
  await expect(window.locator('.wm-modal-content li').first()).toContainText(
    'Settings',
  );
});
