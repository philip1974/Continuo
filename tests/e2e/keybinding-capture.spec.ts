// 编辑快捷键 modal 的捕获行为:Backspace = unbind,任何键 = 新组合,
// 重置默认 / 保存按钮.
import { test, expect } from './fixtures/electron-app';
import { KEYBINDINGS_TAB, openSettingsTab } from './helpers/settings';

const EDIT_HOTKEY = /编辑.*快捷键|Edit hotkey|단축키 편집/;
const SET_HOTKEY = /^(设置快捷键|Set hotkey|단축키 설정)$/;
const UNBOUND = /未绑定|Unbound|바인딩 없음/;
const CANCEL = /^(取消|Cancel|취소)$/;
const SAVE = /^(保存|Save|저장)$/;
const RESET_DEFAULT = /^(重置默认|Reset to default|기본값으로 재설정)$/;

async function openCaptureForFirstCommand(
  window: import('@playwright/test').Page,
): Promise<void> {
  await openSettingsTab(window, KEYBINDINGS_TAB);
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });
  await window.getByRole('button', { name: EDIT_HOTKEY }).first().click();
  await expect(window.getByText(SET_HOTKEY).first()).toBeVisible();
}

test('打开编辑 modal → 输入 Backspace → 「未绑定」', async ({
  window,
}) => {
  await openCaptureForFirstCommand(window);
  const dialog = window.locator('.wm-modal-content').last();

  // 初始可能显当前 hotkey(currentHotkey),也可能显「按下新组合…」(无默认).
  // 不假设初始态,直接 Backspace → captured='' → dialog 显「未绑定」.
  await window.keyboard.press('Backspace');
  await expect(dialog).toContainText(UNBOUND);
});

test('编辑 modal:输入新组合 + 三个底部按钮可见', async ({ window }) => {
  await openCaptureForFirstCommand(window);
  const dialog = window.locator('.wm-modal-content').last();

  // 按 'k' → captured='k';dialog 内 capture 区 KeyCap 含 'K' 字符.
  // 注意 dialog 内还有 Backspace / Esc 两个提示 KeyCap,总数 ≥ 3.
  await window.keyboard.press('KeyK');
  expect(await dialog.locator('kbd.wm-keycap').count()).toBeGreaterThanOrEqual(
    3,
  );

  // 三个底部按钮文本可见
  await expect(dialog.getByRole('button', { name: CANCEL })).toBeVisible();
  await expect(dialog.getByRole('button', { name: SAVE })).toBeVisible();
  await expect(dialog.getByRole('button', { name: RESET_DEFAULT })).toBeVisible();
});
