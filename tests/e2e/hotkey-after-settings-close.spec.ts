// 开 Settings → 关 → Cmd+Shift+P → CommandPalette 仍可唤起.
import { test, expect } from './fixtures/electron-app';

test('Settings 开关后 Cmd+Shift+P 仍唤起 CommandPalette', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });

  await window.locator('button[aria-label="Close Settings"]').click();
  await window.waitForTimeout(400);
  await expect(nav).toBeHidden();

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
  await expect(
    window.locator('.wm-modal-content input[placeholder^="输入命令名"]'),
  ).toBeVisible({ timeout: 5_000 });
});
