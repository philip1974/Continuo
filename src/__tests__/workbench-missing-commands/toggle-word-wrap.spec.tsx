// @vitest-environment jsdom
// BDD: workbench-missing-commands §4 —— 切换自动换行(editor.action.toggleWordWrap,⌥Z):翻转设置 editor.wordWrap,
// 已打开的代码编辑器即时 reconfigure(CodeMirror EditorView.lineWrapping),不重建编辑器;终端里 ⌥Z 留给 shell。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '@/panels/Editor/CodeEditor';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { editorCommandSpecs, TOGGLE_WORD_WRAP_COMMAND, toggleWordWrap } from '@/panels/Editor/editor-commands';
import { EDITOR_WORD_WRAP } from '@/plugins/settings/core-setting-specs';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { isTerminalKeptHotkey } from '@/panels/Terminal/terminal-hotkeys';
import { POPOUT_HOTKEY_COMMAND_IDS, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const A = '/w/a.ts';
/** 编辑区是否换行(EditorView.lineWrapping 扩展给内容区加 cm-lineWrapping)。 */
const wraps = (view: EditorView) => view.contentDOM.classList.contains('cm-lineWrapping');
const wrapSetting = () => useSettingsValuesStore.getState().values[EDITOR_WORD_WRAP.id];

beforeEach(() => {
  useSettingsValuesStore.getState().reset(EDITOR_WORD_WRAP.id);
  useEditorStore.setState({ tabs: [createTab(A, 'x')], activeTabId: A, viewRefs: new Map() });
});
afterEach(() => {
  cleanup();
  useSettingsValuesStore.getState().reset(EDITOR_WORD_WRAP.id);
});

describe('命令与设置', () => {
  it('id 同 VSCode;各平台 ⌥Z / Alt+Z;三语标题;设置默认关闭', () => {
    expect(TOGGLE_WORD_WRAP_COMMAND).toEqual({ id: 'editor.action.toggleWordWrap', hotkey: 'alt+z' });
    for (const platform of ['mac', 'other'] as const) {
      expect(editorCommandSpecs(platform).find((c) => c.id === TOGGLE_WORD_WRAP_COMMAND.id)?.hotkey).toBe('alt+z');
    }
    for (const locale of [en, zh, ko]) {
      expect(locale['commands.editor.toggle_word_wrap.title']).toBeTruthy();
      expect(locale['settings.editor.word_wrap']).toBeTruthy();
    }
    expect(EDITOR_WORD_WRAP).toMatchObject({ id: 'editor.wordWrap', type: 'boolean', default: false, category: 'editor' });
  });

  it('mac 按 ⌥Z(e.key 为 Ω)按物理键命中', () => {
    const e = new KeyboardEvent('keydown', { key: 'Ω', code: 'KeyZ', altKey: true });
    expect(winningCommandFor(e, editorCommandSpecs('mac'), 'mac', {})?.id).toBe(TOGGLE_WORD_WRAP_COMMAND.id);
  });

  it('toggleWordWrap 翻转设置', () => {
    toggleWordWrap();
    expect(wrapSetting()).toBe(true);
    toggleWordWrap();
    expect(wrapSetting()).toBe(false);
  });

  it('终端获焦时 ⌥Z 留给 shell;popout 子窗里也分发', () => {
    const e = new KeyboardEvent('keydown', { key: 'Ω', code: 'KeyZ', altKey: true });
    expect(isTerminalKeptHotkey(e, 'mac', {}, { getAll: () => editorCommandSpecs('mac') })).toBe(true);
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(TOGGLE_WORD_WRAP_COMMAND.id)).toBe(true);
  });
});

describe('代码编辑器', () => {
  it('打开时按设置;切换后已打开的编辑器即时换行 / 取消换行,不重建视图', () => {
    useSettingsValuesStore.getState().setValue(EDITOR_WORD_WRAP.id, true);
    render(<CodeEditor key={A} tabId={A} value="x" fileName={A} onChange={() => {}} />);
    const view = useEditorStore.getState().viewRefs.get(A) as EditorView;
    expect(wraps(view)).toBe(true);
    act(() => toggleWordWrap());
    expect(useEditorStore.getState().viewRefs.get(A)).toBe(view);
    expect(wraps(view)).toBe(false);
    act(() => toggleWordWrap());
    expect(wraps(view)).toBe(true);
  });
});
