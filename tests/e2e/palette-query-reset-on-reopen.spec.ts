// 关命令面板再打开 → query 重置为空.
import { test, expect } from './fixtures/electron-app';

test('palette 输 X → ESC → 重开 → input 为空', async ({ window }) => {
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
  let input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();
  await input.fill('something');
  await expect(input).toHaveValue('something');

  // ESC
  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();

  // 再开
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
  input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toHaveValue('');
});
