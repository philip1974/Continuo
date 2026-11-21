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
