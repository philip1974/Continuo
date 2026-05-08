// override hotkey 后,新组合真触发命令(useCommandHotkeys 走 effective).
import { test, expect } from './fixtures/electron-app';

test('override settings.open 为 mod+shift+y → 按下新组合 → 打开 Settings', async ({
  window,
}) => {
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
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.open', 'mod+shift+y');
  });

  // 按 Ctrl+Shift+Y → 触发 settings.open
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
});

test('override 后 → 旧 hotkey ⌘, 不再触发', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // override 走 setHotkey
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.open', 'mod+shift+y');
  });

  // 按 Ctrl+, (旧 hotkey)
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ',',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // 等待几秒后 nav 仍不可见(旧 hotkey 不再绑定)
  await window.waitForTimeout(500);
  await expect(window.locator('nav[aria-label="设置分类"]')).toHaveCount(0);
});
