// keybindings overrides 持久化:KeybindingCaptureModal 保存 → localStorage
// 'continuo.keybindings.overrides'.
import { test, expect } from './fixtures/electron-app';
import {
  EDIT_HOTKEY_SELECTOR,
  KEYBINDINGS_TAB,
  openSettingsTab,
} from './helpers/settings';

const SET_HOTKEY = /^(设置快捷键|Set hotkey|단축키 설정)$/;
const SAVE = /^(保存|Save|저장)$/;

test('改 settings.toggle hotkey → localStorage 写 overrides', async ({
  window,
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

  // localStorage 写入
  await window.waitForTimeout(100);
  const raw = await window.evaluate(() =>
    localStorage.getItem('continuo.keybindings.overrides'),
  );
  expect(raw).not.toBeNull();
  const data = JSON.parse(raw!) as Record<string, string>;
  expect(data['settings.toggle']).toBe('k');
});
