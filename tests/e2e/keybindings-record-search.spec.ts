// 快捷键页:录制按键搜索(VSCode ⌥⌘K / Alt+K)、符号写法搜索、录键弹窗录带修饰的 Tab。
// BDD: src/__tests__/keybindings-tab-content/ · keybinding-capture-modal/
import { test, expect } from './fixtures/electron-app';
import { EDIT_HOTKEY_SELECTOR, KEYBINDINGS_TAB, openSettingsTab } from './helpers/settings';

const SEARCH = /^(搜索命令名|Search commands|명령어)|^(正在录制按键|Recording Keys|키 기록 중)/;
const RECORD_KEYS = /^(录制按键|Record Keys|키 기록)$/;
const isMac = process.platform === 'darwin';
const PRIMARY = isMac ? 'Meta' : 'Control';
const rowIds = (window: import('@playwright/test').Page) =>
  window.locator('main [data-keybinding-row]').evaluateAll((els) => els.map((el) => el.getAttribute('data-keybinding-row')));

test('录制按键:⌥⌘K 开启 → 按 ⇧⌘P 写成精确查询并过滤,不弹命令面板;Esc 退出保留查询', async ({ window }) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);
  const search = window.getByRole('textbox', { name: SEARCH });
  const toggle = window.getByRole('button', { name: RECORD_KEYS });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await search.focus();
  await window.keyboard.press(isMac ? 'Meta+Alt+KeyK' : 'Alt+KeyK');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(search).toBeFocused();

  await window.keyboard.press(`${PRIMARY}+Shift+KeyP`);
  await expect(search).toHaveValue(isMac ? '"cmd+shift+p"' : '"ctrl+shift+p"');
  await expect.poll(() => rowIds(window)).toEqual(['workbench.action.showCommands']);
  // 按键被录制吃掉:命令面板没弹出
  await expect(window.locator('.wm-modal-content')).toHaveCount(0);

  await window.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(search).toHaveValue(isMac ? '"cmd+shift+p"' : '"ctrl+shift+p"');
});

test('符号写法搜索:⌘⇧P 与 ⇧⌘P 同结果;⌃Tab 命中显示为 ⌃⇥ 的绑定', async ({ window }) => {
  test.skip(!isMac, 'mac 键帽符号');
  await openSettingsTab(window, KEYBINDINGS_TAB);
  const search = window.getByRole('textbox', { name: SEARCH });
  await search.fill('⌘⇧P');
  await expect.poll(() => rowIds(window)).toEqual(['workbench.action.showCommands']);
  await search.fill('⇧⌘P');
  await expect.poll(() => rowIds(window)).toEqual(['workbench.action.showCommands']);
  await search.fill('⌃Tab');
  await expect
    .poll(() => rowIds(window))
    .toEqual(
      expect.arrayContaining([
        'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup',
        'workbench.action.quickOpenLeastRecentlyUsedEditorInGroup',
      ]),
    );
});

test('录键弹窗:⌃Tab 录成组合;无修饰 Tab 仍移动焦点', async ({ window }) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);
  await expect(window.locator('main li').first()).toBeVisible({ timeout: 10_000 });
  await window.locator(EDIT_HOTKEY_SELECTOR).first().click();
  const dialog = window.locator('.wm-modal-content').last();
  const area = dialog.getByTestId('keybinding-capture-area');
  await expect(area).toBeFocused();
  await window.keyboard.press('Control+Tab');
  await expect(area.locator('kbd')).toHaveText(isMac ? ['⌃', '⇥'] : ['Ctrl', 'Tab']);
  // 焦点仍在录制区(⌃Tab 没被当作焦点导航)
  await expect(area).toBeFocused();
  await window.keyboard.press('Tab');
  await expect(area).not.toBeFocused();
  await expect(area.locator('kbd')).toHaveText(isMac ? ['⌃', '⇥'] : ['Ctrl', 'Tab']);
});
