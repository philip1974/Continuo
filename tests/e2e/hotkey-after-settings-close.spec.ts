// 开 Settings → 关 → Cmd+Shift+P → CommandPalette 仍可唤起.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, CLOSE_SETTINGS, SETTINGS_NAV } from './helpers/settings';
import { COMMAND_SEARCH } from './helpers/palette';

test('Settings 开关后 Cmd+Shift+P 仍唤起 CommandPalette', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await window.waitForTimeout(400);
  await expect(nav).toBeHidden();

  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        // 平台主修饰键:mac = Cmd,其它 = Ctrl(mac 上面板热键只认 Cmd)
        ctrlKey: !navigator.platform.toLowerCase().includes('mac'),
        metaKey: navigator.platform.toLowerCase().includes('mac'),
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(
    window.getByRole('combobox', { name: COMMAND_SEARCH }),
  ).toBeVisible({ timeout: 5_000 });
});
