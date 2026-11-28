// @vitest-environment jsdom
// BDD:预览 tab 的显示 —— 标题斜体、双击转常驻、可访问名称追加「，预览」。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorHeader } from '../../panels/Editor/EditorHeader';
import { createTab, groupPreviewTabIdOf, useEditorStore } from '../../stores/editor.store';
import { setLocale, t } from '../../i18n';
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

const tabEl = (name: string | RegExp) => screen.getByRole('tab', { name });
// 界面语言随环境(三语都认)
const PREVIEW_B = /^b\.ts(, preview|，预览|, 미리보기)$/;

describe('预览 tab 的显示', () => {
  it('预览 tab 标题斜体,常驻 tab 不是', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    expect(tabEl(PREVIEW_B).querySelector('.italic')?.textContent).toBe('b.ts');
    expect(tabEl('a.ts').querySelector('.italic')).toBeNull();
  });

  it('可访问名称:预览 tab 追加「，预览」(VSCode computeEditorAriaLabel),常驻 tab 就是文件名;转常驻后后缀去掉', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    expect(tabEl('a.ts')).toBeTruthy();
    expect(tabEl(PREVIEW_B)).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'b.ts' })).toBeNull();
    act(() => useEditorStore.getState().keepTab(B));
    expect(tabEl('b.ts')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: PREVIEW_B })).toBeNull();
  });

  it('双击预览 tab → 转常驻,斜体消失;双击常驻 tab 不改预览状态(改为切换组大小,见 dock-group-sizes)', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    const before = useEditorStore.getState().previewTabs;
    fireEvent.doubleClick(tabEl('a.ts'));
    expect(useEditorStore.getState().previewTabs).toBe(before);
    fireEvent.doubleClick(tabEl(PREVIEW_B));
    expect(groupPreviewTabIdOf(useEditorStore.getState(), 'editor')).toBeUndefined();
    expect(tabEl('b.ts').querySelector('.italic')).toBeNull();
  });

  it('编辑预览 tab(变脏)→ 斜体消失', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    act(() => useEditorStore.getState().updateContent(B, 'x'));
    expect(tabEl('b.ts').querySelector('.italic')).toBeNull();
  });
});

describe('预览 tab 右键「保持打开」(VSCode EditorTitleContext 3_preview keepEditor)', () => {
  const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));
  const labelOf = (el: HTMLElement): string => el.querySelector('.wm-menu-item__content')?.textContent ?? '';
  beforeEach(() => setLocale('zh'));
  afterEach(() => setLocale('en'));

  it('预览 tab 右键:关闭类之后一组「保持打开」(无键位:VSCode ⌘K Enter 是和弦);点击 → 转常驻', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} onCloseTabsRequest={vi.fn()} />);
    fireEvent.contextMenu(tabEl(/^b\.ts，预览$/));
    const labels = items().map(labelOf);
    const keepOpen = t('shell.tab.ctx.keep_open');
    expect(keepOpen).toBe('保持打开');
    expect(labels.indexOf(keepOpen)).toBe(labels.indexOf(t('shell.tab.ctx.close_all')) + 1);
    const item = items().find((el) => labelOf(el) === keepOpen)!;
    expect(item.querySelector('.wm-menu-item__shortcut')).toBeNull();
    fireEvent.click(item);
    expect(groupPreviewTabIdOf(useEditorStore.getState(), 'editor')).toBeUndefined();
  });

  it('常驻 tab 右键没有「保持打开」', () => {
    render(<EditorHeader onCloseRequest={vi.fn()} onCloseTabsRequest={vi.fn()} />);
    fireEvent.contextMenu(tabEl('a.ts'));
    expect(items().map(labelOf)).not.toContain(t('shell.tab.ctx.keep_open'));
  });
});
