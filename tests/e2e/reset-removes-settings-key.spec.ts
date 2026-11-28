// reset 一个 override → 主进程设置文件(user-settings.json)中 key 删除.
import { test, expect } from './fixtures/electron-app';
import { readUserSettingsFile } from './helpers/user-settings-file';
import {
  clickFirstVisibleResetDefault,
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
  settingNumberInput,
} from './helpers/settings';

test('改 fontSize=20 → reset → values 不含 editor.fontSize', async ({
  window,
  userDataDir,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  const fontInput = settingNumberInput(window, 'editor.fontSize');
  await fontInput.fill('20');
  await expect.poll(() => readUserSettingsFile(userDataDir)?.['editor.fontSize']).toBe(20);

  // reset
  await clickFirstVisibleResetDefault(window);

  // editor.fontSize key 删除(文件仍在)
  await expect.poll(() => readUserSettingsFile(userDataDir)).not.toBeNull();
  await expect.poll(() => Object.hasOwn(readUserSettingsFile(userDataDir) ?? { 'editor.fontSize': 0 }, 'editor.fontSize')).toBe(false);
  expect(await window.evaluate(() => globalThis.__continuoTest?.getSettingValue('editor.fontSize'))).toBeUndefined();
});
