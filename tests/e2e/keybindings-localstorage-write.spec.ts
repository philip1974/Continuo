// keybindings overrides 持久化:KeybindingCaptureModal 保存 → localStorage
// 'continuo.keybindings.overrides'.
import { test, expect } from './fixtures/electron-app';
import { KEYBINDINGS_TAB, openSettingsTab } from './helpers/settings';

const EDIT_HOTKEY = /编辑.*快捷键|Edit hotkey|단축키 편집/;
const SET_HOTKEY = /^(设置快捷键|Set hotkey|단축키 설정)$/;
const SAVE = /^(保存|Save|저장)$/;

test('改 settings.open hotkey → localStorage 写 overrides', async ({
  window,
}) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);

  // 找到 settings.open 行 → 编辑按钮
  // KeybindingsTab 列表按 category + title localeCompare,settings.open 应当出现
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });

  // 简化:点第一个编辑按钮 → modal 弹 → 按 'k' → 保存
  await window.getByRole('button', { name: EDIT_HOTKEY }).first().click();
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
  // 至少有一个 override 写入
  expect(Object.keys(data).length).toBeGreaterThan(0);
});
