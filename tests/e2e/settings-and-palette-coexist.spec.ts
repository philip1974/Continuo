// Settings panel 在 dock 内 + Cmd+Shift+P → palette modal 显示在 settings 之上.
import { test, expect } from './fixtures/electron-app';

test('Settings open + Cmd+Shift+P → palette 显 + Settings nav 仍在', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });

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
  await expect(input).toBeVisible({ timeout: 5_000 });

  // Settings nav 仍存在 (dock panel,不会因 modal 关闭)
  await expect(nav).toBeVisible();
});
