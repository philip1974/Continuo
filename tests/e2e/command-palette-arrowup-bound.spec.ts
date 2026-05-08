// CommandPalette ArrowUp 在 selectedIndex=0 → wrap 到末项.
import { test, expect } from './fixtures/electron-app';

test('ArrowUp 在第一项 → wrap 到末项', async ({ window }) => {
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

  const items = window.locator('.wm-modal-content li');
  const count = await items.count();
  expect(count).toBeGreaterThan(0);

  await window.keyboard.press('ArrowUp');

  // 末项底色 active
  const lastClass = await items.last().getAttribute('class');
  expect(lastClass).toContain('bg-hover');
});
