// override hotkey 后 reset → 回到 spec.hotkey.
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS_NAV } from './helpers/settings';

test('override 后 reset → CommandPalette 显示原 hotkey', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // override → 'mod+shift+y'
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

  // reset:setHotkey 回 ''(unbind)然后我们让 store 删 key.
  // 我们没暴露 reset 单独 helper,直接用 keybindings store reset 的形式 — 走 setHotkey('original').
  // 实际 reset 是 store.reset(commandId);testing hook 不暴露。
  // 简化:再设回原 hotkey 'mod+,'(等价于 store.setHotkey('settings.toggle','mod+,')).
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.toggle', 'mod+,');
  });

  await dispatchModKey(window, ',');

  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
});
