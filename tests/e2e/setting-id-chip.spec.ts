// SettingItemRow 的 id chip(<code>):title 后紧贴显示 spec.id(uppercase 样式).
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  TERMINAL_TAB,
  openSettingsTab,
} from './helpers/settings';

test('编辑器 tab 内显示 setting id chip:editor.fontSize', async ({
  window,
}) => {
  await openSettingsTab(window, EDITOR_TAB);

  // chip 是 <code> 元素;查 main 内含 'editor.fontSize' 的 code
  const chip = window
    .locator('main code')
    .filter({ hasText: 'editor.fontSize' });
  await expect(chip).toBeVisible();
});

test('终端 tab 内显示 setting id chip:terminal.cursorStyle', async ({
  window,
}) => {
  await openSettingsTab(window, TERMINAL_TAB);

  const chip = window
    .locator('main code')
    .filter({ hasText: 'terminal.cursorStyle' });
  await expect(chip).toBeVisible();
});
