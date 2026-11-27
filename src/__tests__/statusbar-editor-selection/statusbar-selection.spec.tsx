// @vitest-environment jsdom
// BDD: statusbar-editor-selection —— 状态栏「行 X，列 Y」光标位置项。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { EditorSelection, EditorState } from '@codemirror/state';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { createTab, liveEditorViewOf, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { useIndentationStore } from '../../panels/Editor/editor-indentation';
import {
  selectionStatusLabel,
  selectionStatusOf,
  statusbarColumn,
} from '../../panels/Editor/editor-selection-status';
import { coApp } from '../../plugins/co-app';
import { setLocale, t } from '../../i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const item = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('[data-statusbar-selection]');

beforeEach(() => {
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
  captureLmApi();
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useSettingsValuesStore.setState({ values: {} });
  useIndentationStore.setState({ byTab: new Map() });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'source' });
  setLocale('en');
});
afterEach(() => {
  cleanup();
  useEditorStore.setState({ tabs: [] });
  delete (window as { api?: unknown }).api;
  vi.restoreAllMocks();
});

function state(doc: string, selection: EditorSelection, tabSize = 4): EditorState {
  return EditorState.create({ doc, selection, extensions: [EditorState.tabSize.of(tabSize), EditorState.allowMultipleSelections.of(true)] });
}

describe('位置与选中字符数(VSCode editorStatus / CursorColumns.toStatusbarColumn / getCharacterCountInRange)', () => {
  it('列 = 可视列:tab 跳到下一个制表位(按文档 tabSize),其余每个码点算 1(含表情等代理对)', () => {
    expect(statusbarColumn('abc', 0, 4)).toBe(1);
    expect(statusbarColumn('abc', 3, 4)).toBe(4);
    expect(statusbarColumn('\tx', 1, 4)).toBe(5);
    expect(statusbarColumn('ab\tx', 3, 4)).toBe(5);
    expect(statusbarColumn('\t\tx', 2, 2)).toBe(5);
    expect(statusbarColumn('😀x', 2, 4)).toBe(2);
  });

  it('行列取主选区的头;已选字符数按码点,换行按文件行尾长度(CRLF 算 2)', () => {
    const s = state('one\n\ttwo\nthree', EditorSelection.create([EditorSelection.range(0, 6)]));
    expect(selectionStatusOf(s, 1)).toEqual({ line: 2, col: 6, selections: 1, chars: 6 });
    expect(selectionStatusOf(s, 2).chars).toBe(7);
    const multi = state('ab ab ab', EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 5), EditorSelection.cursor(8)]));
    expect(selectionStatusOf(multi, 1)).toMatchObject({ selections: 3, chars: 4 });
  });

  it('文案:单光标 / 有选中 / 多光标 / 多光标有选中,三语照抄 VSCode 本地化', () => {
    const label = (s: Parameters<typeof selectionStatusLabel>[0]) => {
      const { key, params } = selectionStatusLabel(s);
      return t(key, params);
    };
    expect(label({ line: 16, col: 1, selections: 1, chars: 0 })).toBe('Ln 16, Col 1');
    expect(label({ line: 16, col: 1, selections: 1, chars: 12 })).toBe('Ln 16, Col 1 (12 selected)');
    expect(label({ line: 1, col: 1, selections: 3, chars: 0 })).toBe('3 selections');
    expect(label({ line: 1, col: 1, selections: 3, chars: 9 })).toBe('3 selections (9 characters selected)');
    expect(zh['statusbar.selection.single']).toBe('行 {line}，列 {col}');
    expect(zh['statusbar.selection.single_range']).toBe('行 {line}，列 {col}（已选择{chars}）');
    expect(zh['statusbar.selection.multi']).toBe('{count} 选择');
    expect(zh['statusbar.selection.multi_range']).toBe('{count} 选择（已选择 {chars} 个字符）');
    expect(ko['statusbar.selection.single']).toBe('줄 {line}, 열 {col}');
    expect(ko['statusbar.selection.single_range']).toBe('줄 {line}, 열 {col}({chars} 선택됨)');
    expect([en, zh, ko].map((c) => c['statusbar.selection.tooltip'])).toEqual(['Go to Line/Column', '转到行/列', '줄/열로 이동']);
  });
});

describe('状态栏光标位置项', () => {
  const path = '/w/a.ts';
  const doc = 'const a = 1;\n\tlet b;\n';

  function mountEditor() {
    useEditorStore.getState().openTab(createTab(path, doc));
    render(<CodeEditor tabId={path} value={doc} fileName="a.ts" />);
    const view = liveEditorViewOf(path, useEditorStore.getState().activeGroupId)!;
    expect(view).toBeTruthy();
    return view;
  }

  it('代码编辑器:随光标 / 选区 / 多光标更新,位于缩进项之前', () => {
    const view = mountEditor();
    const { container } = render(<StatusBar />);
    expect(item(container)?.textContent).toBe('Ln 1, Col 1');
    act(() => view.dispatch({ selection: { anchor: 15 } })); // 第 2 行 \tl|et(tab 宽 4 → 列 6)
    expect(item(container)?.textContent).toBe('Ln 2, Col 6');
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
    expect(item(container)?.textContent).toBe('Ln 1, Col 6 (5 selected)');
    act(() =>
      view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(14)]) }),
    );
    expect(item(container)?.textContent).toBe('2 selections');
    const indent = container.querySelector('[data-statusbar-indentation]');
    expect(indent).not.toBeNull();
    expect(item(container)!.compareDocumentPosition(indent!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('打字(内容变化)后列随之更新', () => {
    const view = mountEditor();
    const { container } = render(<StatusBar />);
    act(() => view.dispatch({ changes: { from: 0, insert: 'xx' }, selection: { anchor: 2 } }));
    expect(item(container)?.textContent).toBe('Ln 1, Col 3');
  });

  it('点击 → 转到行/列(workbench.action.gotoLine);悬浮提示「Go to Line/Column」', () => {
    mountEditor();
    const fn = vi.fn();
    const dispose = coApp.commands.register({ id: 'workbench.action.gotoLine', title: 'Go to Line', fn });
    const { container } = render(<StatusBar />);
    expect(item(container)?.title).toBe('Go to Line/Column');
    act(() => fireEvent.click(item(container)!));
    expect(fn).toHaveBeenCalledTimes(1);
    dispose.dispose();
  });

  it('Markdown 编辑 / 预览模式(Milkdown)不显示;源码模式显示;编辑器卸载后不再显示', () => {
    const md = '/w/n.md';
    useEditorStore.getState().openTab(createTab(md, '# a'));
    const editor = render(<CodeEditor tabId={md} value="# a" fileName="n.md" forceLanguage="markdown" />);
    const { container } = render(<StatusBar />);
    expect(item(container)?.textContent).toBe('Ln 1, Col 1');
    act(() => useEditorStore.setState({ mode: 'edit' }));
    expect(item(container)).toBeNull();
    act(() => useEditorStore.setState({ mode: 'source' }));
    expect(item(container)).not.toBeNull();
    act(() => editor.unmount());
    expect(item(container)).toBeNull();
  });
});
