// SettingItemRow 显示 description 文本(若 spec.description 存在).
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  TERMINAL_TAB,
  openSettingsTab,
} from './helpers/settings';

// settings.editor.font_size.desc 的三语原文(只出现在描述里,不与任何设置标题重合)
const EDITOR_FONT_SIZE_DESC =
  /(代码编辑器与 Markdown 编辑器的字号。|Font size for the code editor and the Markdown editor\.|코드 에디터와 Markdown 에디터의 글꼴 크기\.)/;

test('编辑器 tab 显示 fontSize description', async ({ window }) => {
  await openSettingsTab(window, EDITOR_TAB);

  // EditorTabPlugin 为 editor.fontSize 注册了 description
  await expect(window.getByText(EDITOR_FONT_SIZE_DESC).first()).toBeVisible();
});

test('终端 tab 显示 fontSize description', async ({ window }) => {
  await openSettingsTab(window, TERMINAL_TAB);

  // TerminalTabPlugin 注册了 fontSize description 'xterm 字号。变化时自动 fit 重排。'
  await expect(window.locator('main')).toContainText('xterm');
});
