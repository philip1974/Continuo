// SettingItemRow 显示 description 文本(若 spec.description 存在).
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  TERMINAL_TAB,
  openSettingsTab,
} from './helpers/settings';

const FONT_SIZE = /^(字号|Font size|글꼴 크기)$/;

test('编辑器 tab 显示 fontSize description「CodeEditor 字号」之类', async ({
  window,
}) => {
  await openSettingsTab(window, EDITOR_TAB);

  // 验证有 description 文案存在(EditorTabPlugin 注册了 description)
  await expect(window.getByText(FONT_SIZE).first()).toBeVisible();
  // 自动保存说明
  await expect(window.locator('main')).toContainText('Markdown');
});

test('终端 tab 显示 fontSize description', async ({ window }) => {
  await openSettingsTab(window, TERMINAL_TAB);

  // TerminalTabPlugin 注册了 fontSize description 'xterm 字号。变化时自动 fit 重排。'
  await expect(window.locator('main')).toContainText('xterm');
});
