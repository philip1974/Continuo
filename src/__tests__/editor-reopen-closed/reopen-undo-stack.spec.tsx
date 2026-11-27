// @vitest-environment jsdom
// BDD: editor-reopen-closed 第 7 条 —— 关闭文件后重新打开,内容与关闭时相同 → 恢复撤销栈(VSCode files.restoreUndoStack,
// 默认开;ModelService 关闭时按 URI 留下撤销元素与内容 SHA1,重开 SHA1 相同才恢复)。不同 → 丢弃。「不保存」关闭先把磁盘
// 内容作为可撤销的一步套回(VSCode DONT_SAVE → revert → updateModel),重开后 ⌘Z 找回。见同目录 README。
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
  CLOSED_UNDO_DOC_MAX_CHARS,
  CLOSED_UNDO_MEMORY_MAX,
  clearEditorViewStates,
  revertedForDiscard,
  stashClosedCodeEditorState,
  takeClosedCodeEditorState,
} from '../../panels/Editor/editor-view-state-cache';
import { EditorState } from '@codemirror/state';
import { history, undoDepth } from '@codemirror/commands';

const A = '/w/a.ts';
const TEXT = 'line1\nline2\n';

function mount(tabId: string, value: string) {
  const r = render(<CodeEditor key={tabId} tabId={tabId} value={value} fileName={tabId} onChange={() => {}} />);
  const view = useEditorStore.getState().viewRefs.get(tabId) as EditorView;
  return { ...r, view };
}

function undo(view: EditorView): boolean {
  const before = view.state.doc.toString();
  fireEvent.keyDown(view.contentDOM, { key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true });
  return view.state.doc.toString() !== before;
}

function type(view: EditorView, at: number, text: string) {
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
}

/** 打开 A、追加一行(保存后内容 = 磁盘)、关闭 tab(视图仍挂着时关闭,同 ⌘W)。返回关闭时的内容。 */
function editSaveClose(): string {
  useEditorStore.setState({ tabs: [createTab(A, TEXT)], activeTabId: A, viewRefs: new Map() });
  const { view, unmount } = mount(A, TEXT);
  type(view, TEXT.length, 'line3\n');
  const saved = view.state.doc.toString();
  useEditorStore.getState().closeTab(A);
  unmount();
  return saved;
}

function reopen(content: string) {
  useEditorStore.getState().openTab(createTab(A, content));
  return mount(A, content);
}

/** 带一步撤销历史的状态(长度 len)。 */
function stateWithHistory(len: number): EditorState {
  const s = EditorState.create({ doc: 'x'.repeat(len - 1), extensions: [history()] });
  return s.update({ changes: { from: 0, insert: 'y' }, userEvent: 'input.type' }).state;
}

beforeEach(() => {
  clearEditorViewStates();
  // jsdom 没有 Range 的布局接口(关闭时对挂着的视图取滚动快照要用)
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => cleanup());

describe('关闭后重新打开恢复撤销栈', () => {
  it('追加一行 ⌘S → ⌘W → 重新打开(内容未变)→ ⌘Z 撤掉追加的一行', () => {
    const saved = editSaveClose();
    const { view } = reopen(saved);
    expect(view.state.doc.toString()).toBe(saved);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(TEXT);
  });

  it('重新打开时磁盘内容已变(外部修改 / 不保存就关闭)→ 丢弃撤销历史', () => {
    editSaveClose();
    const { view } = reopen('changed elsewhere\n');
    expect(undo(view)).toBe(false);
    // 用掉即丢:再关再开同样没有
    expect(takeClosedCodeEditorState(A)).toBeUndefined();
  });

  it('脏文件「不保存」关闭 → 重新打开是磁盘内容且不脏,⌘Z 一步找回丢弃的修改,再 ⌘Z 撤销更早的编辑', () => {
    useEditorStore.setState({ tabs: [createTab(A, TEXT)], activeTabId: A, viewRefs: new Map() });
    const { view, unmount } = mount(A, TEXT);
    type(view, 0, 'kept\n');
    type(view, TEXT.length + 5, 'lost\n');
    const unsaved = view.state.doc.toString();
    useEditorStore.getState().updateContent(A, unsaved);
    expect(useEditorStore.getState().tabs[0]!.dirty).toBe(true);
    useEditorStore.getState().closeTab(A); // 「不保存」:关闭时仍脏
    unmount();

    const { view: again } = reopen(TEXT);
    expect(again.state.doc.toString()).toBe(TEXT);
    expect(undo(again)).toBe(true);
    expect(again.state.doc.toString()).toBe(unsaved);
    expect(undo(again)).toBe(true);
    expect(again.state.doc.toString()).not.toBe(unsaved);
  });

  it('CRLF 文件「不保存」关闭同样找回;留存状态不是这份未保存内容(Markdown 编辑模式里改的)→ 原样留存', () => {
    const crlf = 'a\r\nb\r\n';
    const base = EditorState.create({ doc: crlf, extensions: [history()] });
    const typed = base.update({ changes: { from: 1, insert: 'X' }, userEvent: 'input.type' }).state;
    const back = revertedForDiscard(typed, 'aX\r\nb\r\n', crlf);
    expect(back.doc.sliceString(0, back.doc.length, '\r\n')).toBe(crlf);
    expect(undoDepth(back)).toBe(2);
    expect(revertedForDiscard(typed, 'something else', crlf)).toBe(typed);
  });

  it('文件被删除 / 移走、切换工作区根 → 留存作废', () => {
    for (const invalidate of [
      () => useEditorStore.getState().removePaths(['/w']),
      () => useEditorStore.getState().renamePath(A, '/w/moved.ts'),
      () => useEditorStore.getState().closeTabsOutsideRoot('/other'),
    ]) {
      const saved = editSaveClose();
      invalidate();
      useEditorStore.setState({ tabs: [], activeTabId: null });
      const { view, unmount } = reopen(saved);
      expect(undo(view)).toBe(false);
      useEditorStore.getState().closeTab(A);
      unmount();
      clearEditorViewStates();
    }
  });

  it('没有撤销历史的不留;过大的文档不留;总量超上限淘汰最早关闭的', () => {
    stashClosedCodeEditorState('/n', EditorState.create({ doc: 'abc', extensions: [history()] }));
    expect(takeClosedCodeEditorState('/n')).toBeUndefined();

    const huge = { doc: { length: CLOSED_UNDO_DOC_MAX_CHARS + 1 } } as unknown as EditorState;
    stashClosedCodeEditorState('/huge', Object.assign(Object.create(stateWithHistory(2)), huge));
    expect(takeClosedCodeEditorState('/huge')).toBeUndefined();

    const third = CLOSED_UNDO_MEMORY_MAX / 2 / 3; // 每个 ≈ 1/3 上限(按 UTF-16 两字节估算)
    stashClosedCodeEditorState('/1', stateWithHistory(third));
    stashClosedCodeEditorState('/2', stateWithHistory(third));
    stashClosedCodeEditorState('/3', stateWithHistory(third));
    stashClosedCodeEditorState('/4', stateWithHistory(third));
    expect(takeClosedCodeEditorState('/1')).toBeUndefined();
    expect(takeClosedCodeEditorState('/2')).toBeDefined();
    expect(takeClosedCodeEditorState('/4')).toBeDefined();
  });
});
