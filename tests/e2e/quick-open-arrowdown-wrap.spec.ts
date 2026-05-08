// Cmd+P 列表 N 项 → ArrowDown N 次 → 回到第一项 active(wrap-around).
import { test, expect } from './fixtures/with-workspace';

test('3 文件 → ArrowDown 3 次 → 第一项 active', async ({ window }) => {
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
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  const items = window.locator('.wm-modal-content li');
  const count = await items.count();
  expect(count).toBeGreaterThanOrEqual(3);

  // ArrowDown count 次 → wrap 回第一
  for (let i = 0; i < count; i++) {
    await window.keyboard.press('ArrowDown');
  }

  const firstClass = await items.first().getAttribute('class');
  expect(firstClass).toContain('bg-hover');
});
