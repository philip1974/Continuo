// Quick Open 输入框 placeholder 含 ⌘⇧P 切到命令面板的提示.
import { test, expect } from './fixtures/electron-app';

test('Quick Open 输入框 placeholder 含「⌘⇧P 切到命令面板」', async ({
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
  const placeholder = await input.getAttribute('placeholder');
  expect(placeholder).toContain('搜索文件名');
  // 提示用户 ⌘⇧P 是命令面板
  expect(placeholder).toContain('⌘⇧P');
});
