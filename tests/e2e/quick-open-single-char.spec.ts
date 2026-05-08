// 单字符 query 'b' → b.ts 在列表.
import { test, expect } from './fixtures/with-workspace';

test('Cmd+P 输 b → b.ts 在列表', async ({ window }) => {
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

  await input.fill('b');
  // b.ts 应在列表
  await expect(
    window.locator('.wm-modal-content li').filter({ hasText: 'b.ts' }).first(),
  ).toBeVisible({ timeout: 5_000 });
});
