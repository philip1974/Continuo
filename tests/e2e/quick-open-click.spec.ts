// Quick Open 点击 li 也能打开文件(不只 Enter).
import { test, expect } from './fixtures/with-workspace';

test('单击 Quick Open 列表项 → 打开 + 关闭 modal', async ({ window }) => {
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
  await input.fill('b.ts');
  const item = window.locator('.wm-modal-content li').first();
  await expect(item).toBeVisible();

  await item.click();

  // modal 关 + b.ts 打开
  await expect(input).toBeHidden();
  await expect(window.locator('header').first()).toContainText('b.ts', {
    timeout: 10_000,
  });
});
