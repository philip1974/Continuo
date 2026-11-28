// keybindings overrides 持久化:KeybindingCaptureModal 保存 → 主进程文件 userData/user-keybindings.json
//(此前是 localStorage 'continuo.keybindings.overrides',见 src/__tests__/user-settings-main-store/)。
import { test, expect } from './fixtures/electron-app';
import { USER_KEYBINDINGS_FILE, readUserSettingsFile } from './helpers/user-settings-file';
import {
  EDIT_HOTKEY_SELECTOR,
  KEYBINDINGS_TAB,
  openSettingsTab,
} from './helpers/settings';

const SET_HOTKEY = /^(设置快捷键|Set hotkey|단축키 설정)$/;
const SAVE = /^(保存|Save|저장)$/;

test('改 settings.toggle hotkey → user-keybindings.json 写 override', async ({
  window,
  userDataDir,
}) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);

  // 找到 settings.toggle 行 → 编辑按钮
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });
  const settingsRow = window.locator('main li').filter({ hasText: 'settings.toggle' });

  await settingsRow.first().locator(EDIT_HOTKEY_SELECTOR).click();
  await expect(window.getByText(SET_HOTKEY).first()).toBeVisible();

  await window.keyboard.press('KeyK');

  // 「保存」按钮(modal 内)— textContent 搜
  const dialog = window.locator('.wm-modal-content').last();
  const saveBtn = dialog.getByRole('button', { name: SAVE });
  await saveBtn.click();
  await expect(dialog).toBeHidden();

  // 主进程文件写入
  await expect.poll(() => readUserSettingsFile(userDataDir, USER_KEYBINDINGS_FILE)?.['settings.toggle']).toBe('k');
});
