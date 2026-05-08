// Quick Open 打开后按 ESC → modal 关闭.
import { test, expect } from './fixtures/electron-app';

test('Ctrl+P 打开 → ESC → modal 关闭', async ({ window }) => {
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.locator(
    '.wm-modal-content input[placeholder*="搜索文件名"]',
  );
  await expect(input).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden({ timeout: 5_000 });
});

test('Ctrl+Shift+P 打开命令面板 → ESC → modal 关闭', async ({ window }) => {
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

  await window.keyboard.press('Escape');
  await expect(input).toBeHidden({ timeout: 5_000 });
});
