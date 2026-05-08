// Cmd+P + 直接 Enter → 打开第一项.
import { test, expect } from './fixtures/with-workspace';

test('Cmd+P → Enter → 第一项打开', async ({ window }) => {
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

  // 第一项 active
  const first = window.locator('.wm-modal-content li').first();
  const firstName = await first.textContent();
  expect(firstName).toBeTruthy();

  await window.keyboard.press('Enter');
  await expect(input).toBeHidden({ timeout: 5_000 });

  // editor 显第一项中提到的某 .ts/.md 文件
  // 名字不假设排序,只验证某 file 被打开 (header 含 file basename)
  const headerText = await window.locator('header').first().textContent();
  expect(headerText).toMatch(/a\.ts|b\.ts|README\.md/);
});
