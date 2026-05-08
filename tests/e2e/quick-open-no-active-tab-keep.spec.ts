// Quick Open 关闭后 → editor 中 active tab 不变.
import { test, expect } from './fixtures/with-workspace';

test('打开 README.md → Quick Open 选 a.ts → README.md tab 仍在 + a.ts 新 tab', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // Quick Open 打开
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
  await input.fill('a.ts');
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts');

  await window.keyboard.press('Enter');
  await expect(input).toBeHidden();

  // 现在有 2 个 tab
  const tabs = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.filter({ hasText: 'README.md' })).toHaveCount(1);
  await expect(tabs.filter({ hasText: 'a.ts' })).toHaveCount(1);
});
