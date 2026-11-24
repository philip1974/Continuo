// 注册无 hotkey 命令 → 不影响现有 hotkey;Cmd+, 仍触发 settings.toggle.
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

test('register e2e.silent(无 hotkey)→ Cmd+, 仍触发 settings.toggle', async ({
  window,
}) => {
  await waitForTestHooks(window);
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.registerCommand('e2e.silent', 'Silent Cmd');
  });

  await dispatchModKey(window, ',');
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 5_000,
  });
});
