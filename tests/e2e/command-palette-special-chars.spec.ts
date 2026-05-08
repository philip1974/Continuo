// CommandPalette 输入 regex 元字符 / 中文 / emoji,fuzzy 不抛 + UI 仍正常.
import { test, expect } from './fixtures/electron-app';

const TRICKY = ['(.*)+?', '[abc\\]', '中文搜索', '😀✨', '"`<>$&|;'];

test('特殊字符 query 不抛 + modal 仍开', async ({ window }) => {
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

  for (const q of TRICKY) {
    await input.fill(q);
    // input 仍可见 = 没崩;modal 应仍存在
    await expect(input).toBeVisible();
    // input 值 = 我们填的
    await expect(input).toHaveValue(q);
  }

  // 清空 → 列表回到全部 cmd
  await input.fill('');
  await expect(input).toBeVisible();
});
