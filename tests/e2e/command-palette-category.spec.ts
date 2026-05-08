// CommandPalette 列表项含 category prefix:'Settings: 打开 Settings'.
import { test, expect } from './fixtures/electron-app';

test('settings.open 命令显「Settings:」前缀 + title', async ({ window }) => {
  // 等就绪
  await expect(window.locator('button[title="设置"]')).toBeVisible({
    timeout: 10_000,
  });

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
  await input.fill('打开 Settings');

  const firstLi = window.locator('.wm-modal-content li').first();
  await expect(firstLi).toBeVisible();
  // category 前缀 'Settings:'
  await expect(firstLi).toContainText('Settings');
  // title '打开 Settings'
  await expect(firstLi).toContainText('打开 Settings');
});
