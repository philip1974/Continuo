// @vitest-environment jsdom
// 性能:拖侧栏宽度时 useColumnResize 每个 mousemove 都 setSidebarWidth。宽度变化只应重渲
// 侧栏外壳(aside 宽度 / separator aria-valuenow),不应级联重渲 Explorer → FolderTree(useTree
// setConfig、virtualizer、全部可见 FileRow 与每行 Radix ContextMenu)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const counts = vi.hoisted(() => ({ folderTree: 0 }));

vi.mock('../../panels/Explorer/FolderTree', () => ({
  FolderTree: ({ root }: { root: string }) => {
    counts.folderTree += 1;
    return <div data-testid="folder-tree">{root}</div>;
  },
}));

import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  counts.folderTree = 0;
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
});
afterEach(() => cleanup());

describe('ExplorerSidebar · 宽度变化不重渲 Explorer 子树', () => {
  it('sidebarWidth 连续变化 → aside 宽度更新,FolderTree 不重渲', () => {
    const { container, getByTestId } = render(<ExplorerSidebar />);
    expect(getByTestId('folder-tree').textContent).toBe('/work');
    const base = counts.folderTree;

    for (const w of [300, 320, 340]) {
      act(() => {
        useLayoutUiStore.setState({ sidebarWidth: w });
      });
    }

    expect(container.querySelector('aside')!.style.width).toBe('340px');
    expect(container.querySelector('[role=separator]')!.getAttribute('aria-valuenow')).toBe(
      '340',
    );
    expect(counts.folderTree).toBe(base);
  });

  it('root 变化仍驱动 Explorer 重渲(语义不变)', () => {
    const { getByTestId } = render(<ExplorerSidebar />);
    act(() => {
      useWorkspaceStore.setState({ root: '/other' });
    });
    expect(getByTestId('folder-tree').textContent).toBe('/other');
  });
});
