// @vitest-environment jsdom
// BDD: editor-navigation-history 第 2 条 —— 转到行(Quick Open `:`):实时预览与 Esc 取消不记;Enter 记「原位置 → 目标」。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';

vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { openGotoLine } from '../../panels/Editor/editor-commands';
import {
  installNavigationHistory,
  navigateBack,
  navigationStack,
  resetNavigationHistory,
} from '../../panels/Editor/navigation-history';
import { navigationHistoryExtension } from '../../panels/Editor/codemirror-navigation-history';

const TAB = '/w/a.ts';
const DOC = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
let view: EditorView | null = null;
let uninstall: () => void = () => {};

/** 活动 tab 的视图,光标在第 200 行(打开后用户已点过,当前这条有光标)。 */
function mountEditor(): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const doc = EditorState.create({ doc: DOC }).doc;
  const v = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: EditorSelection.cursor(doc.line(199).from),
      extensions: navigationHistoryExtension(TAB, 'editor'),
    }),
    parent,
  });
  useEditorStore.getState().openTab(createTab(TAB, DOC));
  useEditorStore.getState().registerView(TAB, v, 'editor');
  v.dispatch({ selection: { anchor: doc.line(200).from } });
  view = v;
  return v;
}

const cursorLine = (v: EditorView): number => v.state.doc.lineAt(v.state.selection.main.head).number;
const lines = (): number[] => navigationStack().entries.map((e) => e.selection?.line ?? 0);
const input = (): HTMLInputElement => screen.getByRole('combobox') as HTMLInputElement;
const type = (q: string): void => {
  fireEvent.change(input(), { target: { value: q } });
};

beforeAll(() => {
  uninstall = installNavigationHistory();
});
afterAll(() => uninstall());

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0, results: [], loading: false, scanFailed: false });
  resetNavigationHistory();
});

afterEach(() => {
  cleanup();
  if (view) {
    useEditorStore.getState().unregisterView(TAB, view);
    view.dom.remove();
    view.destroy();
    view = null;
  }
});

describe('转到行与导航记录', () => {
  it('逐位键入的实时预览不记;Enter 记原位置 → 目标,后退回到原行', async () => {
    const v = mountEditor();
    expect(lines()).toEqual([200]);
    openGotoLine();
    render(<QuickOpenModal />);
    type(':3');
    await waitFor(() => expect(cursorLine(v)).toBe(3));
    type(':35');
    await waitFor(() => expect(cursorLine(v)).toBe(35));
    type(':350');
    await waitFor(() => expect(cursorLine(v)).toBe(350));
    expect(lines()).toEqual([200]);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(lines()).toEqual([200, 350]));
    await act(async () => {
      await navigateBack();
    });
    expect(cursorLine(v)).toBe(200);
  });

  it('Esc 取消(预览过)→ 不记', async () => {
    const v = mountEditor();
    openGotoLine();
    render(<QuickOpenModal />);
    type(':380');
    await waitFor(() => expect(cursorLine(v)).toBe(380));
    act(() => useQuickOpenStore.getState().close());
    expect(cursorLine(v)).toBe(200);
    expect(lines()).toEqual([200]);
  });
});
