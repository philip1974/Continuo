// @vitest-environment jsdom
// BDD:固定 tab 的 tab 栏表现 —— 图钉代替 ×、点图钉取消固定、中键 / Delete 不关、右键「固定 / 取消固定」、读屏后缀、
// 「关闭其他」保留固定的。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('@/plugins/sandbox-sweep', () => ({ getCachedClipboard: () => ({ writeText: vi.fn() }) }));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: { reveal: vi.fn() } } }));

import { EditorHeader } from '@/panels/Editor/EditorHeader';
import { groupStickyTabsOf, useEditorStore, type EditorTab } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { setLocale } from '@/i18n';

const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));
const labelOf = (el: HTMLElement): string => el.querySelector('.wm-menu-item__content')?.textContent ?? '';
const item = (label: string): HTMLElement => items().find((el) => labelOf(el) === label)!;
const tabEl = (name: string): HTMLElement =>
  Array.from(document.querySelectorAll<HTMLElement>('[role=tab]')).find((el) => el.textContent?.startsWith(name))!;
const afterMenuClose = () => act(() => new Promise((r) => setTimeout(r, 0)));

function editorTab(id: string): EditorTab {
  return { id, filePath: id, content: '', originalContent: '', dirty: false };
}

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';

function renderHeader(onCloseRequest = vi.fn(), onCloseTabsRequest = vi.fn()) {
  useEditorStore.setState({
    tabs: [editorTab(A), editorTab(B), editorTab(C)],
    activeTabId: A,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    stickyTabs: new Map(),
    previewTabs: new Map(),
    mode: 'source',
  });
  useWorkspaceStore.setState({ root: '/w' });
  render(<EditorHeader onCloseRequest={onCloseRequest} onCloseTabsRequest={onCloseTabsRequest} />);
  return { onCloseRequest, onCloseTabsRequest };
}

beforeEach(() => setLocale('en'));
afterEach(() => cleanup());

describe('固定 tab 的 tab 栏', () => {
  it('右键「Pin」→ 移到最左、显示图钉代替 ×;读屏名带「, pinned」', async () => {
    renderHeader();
    fireEvent.contextMenu(tabEl('c.ts'));
    fireEvent.click(item('Pin'));
    await afterMenuClose();
    expect(groupStickyTabsOf(useEditorStore.getState(), 'editor')).toEqual([C]);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role=tab]'));
    expect(tabs[0]!.textContent).toContain('c.ts');
    expect(tabs[0]!.dataset.pinned).toBe('true');
    expect(tabs[0]!.querySelector('.wm-tab-nav-item__close')).toBeNull();
    expect(tabs[0]!.querySelector('[aria-label="Unpin c.ts"]')).not.toBeNull();
    expect(tabs[0]!.getAttribute('aria-label')).toBe('c.ts, pinned');
    expect(tabs[1]!.querySelector('.wm-tab-nav-item__close')).not.toBeNull();
  });

  it('点图钉 → 取消固定(回到第一个非固定位置),× 回来', () => {
    renderHeader();
    act(() => useEditorStore.getState().pinEditor(B));
    fireEvent.click(tabEl('b.ts').querySelector('.wm-tab-nav-item__pin')!);
    expect(groupStickyTabsOf(useEditorStore.getState(), 'editor')).toEqual([]);
    expect(tabEl('b.ts').querySelector('.wm-tab-nav-item__close')).not.toBeNull();
  });

  it('中键 / Delete 不关固定的 tab;右键「Close」照常关', async () => {
    const { onCloseRequest, onCloseTabsRequest } = renderHeader();
    act(() => useEditorStore.getState().pinEditor(B));
    fireEvent(tabEl('b.ts'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    fireEvent.keyDown(tabEl('b.ts'), { key: 'Delete' });
    expect(onCloseRequest).not.toHaveBeenCalled();
    fireEvent.contextMenu(tabEl('b.ts'));
    expect(items().map(labelOf)).toContain('Unpin');
    fireEvent.click(item('Close'));
    await afterMenuClose();
    expect(onCloseTabsRequest).toHaveBeenCalledWith([B]);
  });

  it('「Close Others」/「Close All」保留固定的', async () => {
    const { onCloseTabsRequest } = renderHeader();
    act(() => useEditorStore.getState().pinEditor(B));
    fireEvent.contextMenu(tabEl('c.ts'));
    fireEvent.click(item('Close Others'));
    await afterMenuClose();
    expect(onCloseTabsRequest).toHaveBeenLastCalledWith([A]);
    fireEvent.contextMenu(tabEl('c.ts'));
    fireEvent.click(item('Close All'));
    await afterMenuClose();
    expect(onCloseTabsRequest).toHaveBeenLastCalledWith([A, C]);
  });
});
