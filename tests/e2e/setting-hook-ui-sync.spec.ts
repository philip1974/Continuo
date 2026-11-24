// SettingsPanel 打开时 setSettingValue → input value 同步.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

test('SettingsPanel 显 + hook setValue → input 同步', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  const fontInput = window.locator('input[type=number]').first();
  await expect(fontInput).toHaveValue('13');

  await waitForTestHooks(window);
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setSettingValue('editor.fontSize', 18);
  });

  await expect(fontInput).toHaveValue('18', { timeout: 3_000 });
});
