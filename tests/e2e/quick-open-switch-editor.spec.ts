// 已开 README.md → Cmd+P 选 b.ts → editor 切到 b.ts.
import { test, expect } from './fixtures/with-workspace';

test('Cmd+P 选 b.ts → editor 切到 b.ts', async ({ window }) => {
  // 先开 README.md
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // Cmd+P → 输 b → Enter
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
  await input.fill('b');
  await expect(window.locator('.wm-modal-content li').first()).toContainText(
    'b.ts',
    { timeout: 5_000 },
  );
  await window.keyboard.press('Enter');

  // editor 现在 active = b.ts
  await expect(window.locator('header').first()).toContainText('b.ts', {
    timeout: 10_000,
  });
});
