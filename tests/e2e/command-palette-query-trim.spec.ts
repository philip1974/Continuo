// CommandPalette 输入空格 → trim 后视为空 query → 显 recent / 全部命令.
// 实际行为:fuzzy 匹配空字符串 → 全匹配.
import { test, expect } from './fixtures/electron-app';

test('全空格 query → 列表项 = 全部命令(等同空 query)', async ({ window }) => {
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

  // 空 query 状态下记录初始数
  const initial = await window.locator('.wm-modal-content li').count();
  expect(initial).toBeGreaterThan(0);

  // 输入空格
  await input.fill('   ');
  // 全空格 fuzzy 不过滤,数量同初始
  const afterSpaces = await window.locator('.wm-modal-content li').count();
  expect(afterSpaces).toBe(initial);
});
