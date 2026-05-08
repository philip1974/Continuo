// Quick Open 无 root 时打开 → 占位文案 + Enter 不抛.
import { test, expect } from './fixtures/electron-app';

test('无 root + Quick Open + Enter → 不抛 + 占位仍显', async ({
  window,
}) => {
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
  await expect(window.locator('.wm-modal-content')).toContainText(
    '请先在 Explorer 打开工作区',
  );

  // 没有 list item 也不抛
  await window.keyboard.press('Enter');
  await expect(input).toBeVisible();
});
