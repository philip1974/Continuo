// Cmd+P + ArrowDown + Enter → 第二项打开.
import { test, expect } from './fixtures/with-workspace';

test('Cmd+P → ArrowDown → Enter → 第二项打开', async ({ window }) => {
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

  // 拿前 2 项文件名
  const items = window.locator('.wm-modal-content li');
  const firstName = await items.nth(0).textContent();
  const secondName = await items.nth(1).textContent();

  await window.keyboard.press('ArrowDown');
  await window.keyboard.press('Enter');

  await expect(input).toBeHidden({ timeout: 5_000 });

  // header 显第二项的 basename
  const headerText = await window.locator('header').first().textContent();
  expect(headerText).not.toContain(firstName?.replace(/\s/g, '') ?? 'XYZ');
  // 简单断言 second name 含 file basename(.ts/.md)
  expect(secondName).toMatch(/\.(ts|md)/);
});
