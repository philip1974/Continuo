// Cmd+P + ArrowDown + Enter → 第二项打开.
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('Cmd+P → ArrowDown → Enter → 第二项打开', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 拿前 2 项的名字(span.font-medium;整行文本是「名字 + 相对路径」拼接)
  const names = window.locator('.wm-modal-content li span.font-medium');
  const firstName = (await names.nth(0).textContent()) ?? '';
  const secondName = (await names.nth(1).textContent()) ?? '';
  expect(secondName).not.toBe(firstName);

  await window.keyboard.press('ArrowDown');
  await window.keyboard.press('Enter');

  await expect(input).toBeHidden({ timeout: 5_000 });

  // 打开的是第二项:header 显示它的名字
  await expect(window.locator('header').first()).toContainText(secondName, { timeout: 5_000 });
});
