// Quick Open selectedIndex=0 时 ArrowUp → wrap 到末项.
import { test, expect } from './fixtures/with-workspace';

test('Quick Open ArrowUp 在第一项 → wrap 到末项', async ({ window }) => {
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

  // 等 walk 完成 → README.md / a.ts / b.ts 出现
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  const items = window.locator('.wm-modal-content li');
  const count = await items.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // selectedIndex=0;ArrowUp wrap 到 count-1
  await window.keyboard.press('ArrowUp');
  // 末项底色为 bg-hover
  const lastClass = await items.last().getAttribute('class');
  expect(lastClass).toContain('bg-hover');
});
