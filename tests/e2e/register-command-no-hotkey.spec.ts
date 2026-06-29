// 注册无 hotkey 命令 → 不影响现有 hotkey;Cmd+, 仍触发 settings.toggle.
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('register e2e.silent(无 hotkey)→ Cmd+, 仍触发 settings.toggle', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

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
    t.registerCommand('e2e.silent', 'Silent Cmd');
  });

  await dispatchModKey(window, ',');
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 5_000,
  });
});
