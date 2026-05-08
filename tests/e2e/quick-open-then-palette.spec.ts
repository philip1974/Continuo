// QuickOpen 开 → Cmd+Shift+P 触发 palette → 多个 .wm-modal-content 并存或 QO 关.
import { test, expect } from './fixtures/electron-app';

test('QuickOpen 开 → Cmd+Shift+P → CommandPalette 也响应', async ({
  window,
}) => {
  // 开 QuickOpen
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
  const qoInput = window.locator(
    '.wm-modal-content input[placeholder*="搜索文件名"]',
  );
  await expect(qoInput).toBeVisible({ timeout: 5_000 });

  // 触发 palette
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

  // CommandPalette input 应可见
  const cpInput = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(cpInput).toBeVisible({ timeout: 5_000 });
});
