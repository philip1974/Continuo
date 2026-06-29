// override hotkey 后,新组合真触发命令(useCommandHotkeys 走 effective).
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS_NAV } from './helpers/settings';

test('override settings.toggle 为 mod+shift+y → 按下新组合 → 打开 Settings', async ({
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
    t.setHotkey('settings.toggle', 'mod+shift+y');
  });

  await dispatchModKey(window, 'y', { shift: true });

  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
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
    t.setHotkey('settings.toggle', 'mod+shift+y');
  });

  await dispatchModKey(window, ',');

  // 等待几秒后 nav 仍不可见(旧 hotkey 不再绑定)
  await window.waitForTimeout(500);
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toHaveCount(0);
});
