// Cmd+P + 直接 Enter → 打开第一项.
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('Cmd+P → Enter → 第一项打开', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 第一项的文件名(span.font-medium)
  const firstName = (
    await window.locator('.wm-modal-content li').first().locator('span.font-medium').textContent()
  )?.trim();
  expect(firstName).toBeTruthy();

  await window.keyboard.press('Enter');
  await expect(input).toBeHidden({ timeout: 5_000 });

  // 打开的正是第一项
  await expect(window.locator('header').first()).toContainText(firstName as string, { timeout: 5_000 });
});
