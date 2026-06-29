// SettingsPanel 打开时 setSettingValue → input value 同步.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

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
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('editor.fontSize', 18);
  });

  await expect(fontInput).toHaveValue('18', { timeout: 3_000 });
});
