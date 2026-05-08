// 通过 testing hook 动态 register 一条命令 → CommandPalette 列表立刻含它.
import { test, expect } from './fixtures/electron-app';

test('动态注册命令 → CommandPalette 立刻显示', async ({ window }) => {
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
    t.registerCommand('e2e.dynamic', 'E2E Dynamic Command');
  });

  // 打开命令面板
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

  await input.fill('E2E Dynamic');
  await expect(window.locator('.wm-modal-content li').first()).toContainText(
    'E2E Dynamic Command',
  );
});
