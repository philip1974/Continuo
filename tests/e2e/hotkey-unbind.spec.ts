// unbind hotkey(空字符串覆盖)→ 该 hotkey 不再触发命令.
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('unbind settings.toggle(空字符串)→ ⌘, 不再触发', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // unbind
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.toggle', '');
  });

  await dispatchModKey(window, ',');
  await window.waitForTimeout(500);

  // Settings panel 不应打开
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toHaveCount(0);

  // 但齿轮按钮点击仍能开
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
});
