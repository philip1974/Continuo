// @vitest-environment jsdom
// 编辑器视图状态按 tab 保留(VSCode:每个文件各自保留撤销栈、光标与滚动)。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { createTab, useEditorStore } from '../../stores/editor.store';
import {
  CODE_EDITOR_VIEW_STATE_LIMIT,
  clearEditorViewStates,
  hasCodeEditorViewState,
} from '../../panels/Editor/editor-view-state-cache';

const A = '/w/a.ts';
const TEXT = 'line1\nline2\nline3\n';

function openTabs(...paths: string[]) {
  useEditorStore.setState({
    tabs: paths.map((p) => createTab(p, TEXT)),
    activeTabId: paths[0] ?? null,
    viewRefs: new Map(),
  });
}

function mount(tabId: string, value: string, onChange: (v: string) => void = () => {}) {
  const r = render(<CodeEditor key={tabId} tabId={tabId} value={value} fileName={tabId} onChange={onChange} />);
  const view = useEditorStore.getState().viewRefs.get(tabId) as EditorView;
  expect(view).toBeTruthy();
  return { ...r, view };
}

/** 按撤销键(jsdom 非 mac:Ctrl+Z,走 basicSetup 的 historyKeymap);返回文档是否被撤销改动。 */
function undo(view: EditorView): boolean {
  const before = view.state.doc.toString();
  fireEvent.keyDown(view.contentDOM, { key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true });
  return view.state.doc.toString() !== before;
}

/** 模拟用户输入(进撤销历史)。 */
function type(view: EditorView, at: number, text: string) {
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
}

beforeEach(() => {
  clearEditorViewStates();
  openTabs(A, '/w/b.ts');
});
afterEach(() => cleanup());

describe('CodeEditor 视图状态按 tab 保留', () => {
  it('切走再切回(卸载后同 tab 重挂、内容未变)→ 撤销历史与光标保留', () => {
    const first = mount(A, TEXT);
    type(first.view, 6, 'X');
    const edited = first.view.state.doc.toString();
    first.unmount();

    const second = mount(A, edited);
    expect(second.view.state.selection.main.head).toBe(7);
    expect(undo(second.view)).toBe(true);
    expect(second.view.state.doc.toString()).toBe(TEXT);
  });

  it('重挂后输入走新实例的 onChange(复用的状态不残留旧组件的监听)', () => {
    const oldChange = vi.fn();
    const first = mount(A, TEXT, oldChange);
    type(first.view, 0, 'a');
    first.unmount();
    oldChange.mockClear();

    const newChange = vi.fn();
    const second = mount(A, `a${TEXT}`, newChange);
    type(second.view, 0, 'b');
    expect(newChange).toHaveBeenCalledWith(`ba${TEXT}`);
    expect(oldChange).not.toHaveBeenCalled();
  });

  it('切走期间内容被别处改了(值与缓存文档不同)→ 不复用撤销历史,光标收进合法范围', () => {
    const first = mount(A, TEXT);
    first.view.dispatch({ selection: { anchor: TEXT.length } });
    type(first.view, TEXT.length, 'tail');
    first.unmount();

    const second = mount(A, 'short');
    expect(second.view.state.doc.toString()).toBe('short');
    expect(undo(second.view)).toBe(false);
    expect(second.view.state.selection.main.head).toBeLessThanOrEqual(5);
  });

  it('重命名(tab 换 id)后以新 id 挂载 → 撤销历史与光标跟随', () => {
    const first = mount(A, TEXT);
    type(first.view, 6, 'X');
    const edited = first.view.state.doc.toString();
    useEditorStore.getState().renamePath(A, '/w/renamed.ts');
    first.unmount();

    const second = mount('/w/renamed.ts', edited);
    expect(second.view.state.selection.main.head).toBe(7);
    expect(undo(second.view)).toBe(true);
    expect(hasCodeEditorViewState(A)).toBe(false);
  });

  it('关闭 tab → 丢弃其视图状态;同路径重开、内容与关闭时不同 → 不恢复旧撤销历史(内容相同的恢复见 editor-reopen-closed)', () => {
    const first = mount(A, TEXT);
    type(first.view, 0, 'a');
    first.unmount();
    expect(hasCodeEditorViewState(A)).toBe(true);
    useEditorStore.getState().closeTab(A);
    expect(hasCodeEditorViewState(A)).toBe(false);

    useEditorStore.getState().openTab(createTab(A, TEXT));
    const second = mount(A, TEXT);
    expect(undo(second.view)).toBe(false);
  });

  it('已关闭 tab 的编辑器随后卸载时不再存入视图状态', () => {
    const first = mount(A, TEXT);
    type(first.view, 0, 'a');
    useEditorStore.getState().closeTab(A);
    first.unmount();
    expect(hasCodeEditorViewState(A)).toBe(false);
  });

  it(`最多保留 ${CODE_EDITOR_VIEW_STATE_LIMIT} 个 tab 的视图状态(最久未用的先淘汰)`, () => {
    const paths = Array.from({ length: CODE_EDITOR_VIEW_STATE_LIMIT + 1 }, (_, i) => `/w/f${i}.ts`);
    openTabs(...paths);
    for (const p of paths) mount(p, TEXT).unmount();
    expect(hasCodeEditorViewState(paths[0]!)).toBe(false);
    expect(hasCodeEditorViewState(paths[1]!)).toBe(true);
    expect(hasCodeEditorViewState(paths.at(-1)!)).toBe(true);
  });
});
