// SettingsValuesStore 持久化:setValue → 主进程文件 userData/user-settings.json(此前是 localStorage
// 'continuo.settings.values',见 src/__tests__/user-settings-main-store/)。
import { test, expect } from './fixtures/electron-app';
import { readUserSettingsFile } from './helpers/user-settings-file';
import {
  clickFirstVisibleResetDefault,
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
  settingNumberInput,
} from './helpers/settings';

test('改 fontSize=20 → user-settings.json 写入 editor.fontSize=20', async ({
  window,
  userDataDir,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  await settingNumberInput(window, 'editor.fontSize').fill('20');
  await expect.poll(() => readUserSettingsFile(userDataDir)?.['editor.fontSize']).toBe(20);
});

test('reset fontSize → user-settings.json 删 key', async ({ window, userDataDir }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  // 改 + 验证写入(否则下面「reset 后 key 不在」可能是因为根本没写进去)
  await settingNumberInput(window, 'editor.fontSize').fill('22');
  await expect.poll(() => readUserSettingsFile(userDataDir)?.['editor.fontSize']).toBe(22);

  // 点 reset(找 not-invisible 的)
  await clickFirstVisibleResetDefault(window);

  await expect
    .poll(() => {
      const r = readUserSettingsFile(userDataDir);
      return r === null ? 'missing' : Object.hasOwn(r, 'editor.fontSize');
    })
    .toBe(false);
});
