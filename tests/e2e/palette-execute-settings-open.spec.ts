// CommandPalette 输 settings → Enter → settings.open 命令执行 → Settings panel 出.
import { test, expect } from './fixtures/electron-app';

test('Cmd+Shift+P → settings → Enter → Settings nav 出', async ({
  window,
}) => {
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
  await input.fill('Settings');
  await expect(window.locator('.wm-modal-content li').first()).toBeVisible();

  await window.keyboard.press('Enter');
  await expect(input).toBeHidden({ timeout: 5_000 });

  // Settings nav
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 5_000,
  });
});
