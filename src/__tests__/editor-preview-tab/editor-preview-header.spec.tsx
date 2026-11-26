// @vitest-environment jsdom
// BDD:预览 tab 的显示 —— 标题斜体、双击转常驻、可访问名称不变。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorHeader } from '../../panels/Editor/EditorHeader';
import { createTab, groupPreviewTabIdOf, useEditorStore } from '../../stores/editor.store';
import { coApp } from '../../plugins/co-app';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';

const A = '/w/a.ts';
const B = '/w/b.ts';

beforeEach(() => {
  (coApp as { editorActions: EditorActionRegistry }).editorActions = new EditorActionRegistry();
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
  });
  const st = useEditorStore.getState();
  st.openTab(createTab(A, ''));
  st.openTab(createTab(B, ''), { preview: true });
});

afterEach(() => cleanup());

const tabEl = (name: string) => screen.getByRole('tab', { name });

describe('预览 tab 的显示', () => {
  it('预览 tab 标题斜体,常驻 tab 不是;可访问名称就是文件名(不加后缀)', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    expect(tabEl('b.ts').querySelector('.italic')?.textContent).toBe('b.ts');
    expect(tabEl('a.ts').querySelector('.italic')).toBeNull();
  });

  it('双击预览 tab → 转常驻,斜体消失;双击常驻 tab 无动作', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    const before = useEditorStore.getState().previewTabs;
    fireEvent.doubleClick(tabEl('a.ts'));
    expect(useEditorStore.getState().previewTabs).toBe(before);
    fireEvent.doubleClick(tabEl('b.ts'));
    expect(groupPreviewTabIdOf(useEditorStore.getState(), 'editor')).toBeUndefined();
    expect(tabEl('b.ts').querySelector('.italic')).toBeNull();
  });

  it('编辑预览 tab(变脏)→ 斜体消失', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    act(() => useEditorStore.getState().updateContent(B, 'x'));
    expect(tabEl('b.ts').querySelector('.italic')).toBeNull();
  });
});
