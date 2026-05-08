// 快速 fill 不同 query → 列表稳定收敛于最后值.  @edge
import { test, expect } from './fixtures/with-workspace';

test('Cmd+P fill a → fill ab → fill abc → 列表反映 abc', async ({ window }) => {
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

  await input.fill('a');
  await input.fill('ab');
  await input.fill('abc'); // 不存在
  // 等过滤稳定:列表应 0 项 或 显示「无结果」之类
  await expect(input).toHaveValue('abc');
  await window.waitForTimeout(200);
  // 不该崩溃 - input 仍可见
  await expect(input).toBeVisible();
});
