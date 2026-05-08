// registerCommand + hotkey → CommandPalette 列表项右侧 KeyCap kbd 显示.
import { test, expect } from './fixtures/electron-app';

test('动态注册命令 + hotkey → palette 显 KeyCap', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (
            id: string,
            title: string,
            hotkey?: string,
          ) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.kbd-display', 'KbdDisplay Test', 'mod+shift+t');
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
  await expect(input).toBeVisible({ timeout: 5_000 });

  await input.fill('KbdDisplay');
  const item = window.locator('.wm-modal-content li').first();
  await expect(item).toContainText('KbdDisplay Test');

  // 该项右侧有 ≥ 1 个 kbd.wm-keycap(formatHotkeyParts)
  const kbds = item.locator('kbd.wm-keycap');
  expect(await kbds.count()).toBeGreaterThan(0);
});
