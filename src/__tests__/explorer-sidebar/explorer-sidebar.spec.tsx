// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  _resetLmApiForTest();
  // 没 workspace → Explorer 渲染 EmptyWorkspace,避开 FolderTree 重依赖
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  Object.defineProperty(window, 'api', {
    value: { fs: { selectDirectory: vi.fn() } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('ExplorerSidebar', () => {
  it('sidebarOpen=false → 不渲染', () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    const { container } = render(<ExplorerSidebar />);
    expect(container.querySelector('aside')).toBeNull();
  });

  it('sidebarOpen=true → 渲染 aside,内含拖拽条', () => {
    const { container } = render(<ExplorerSidebar />);
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside!.style.width).toBe('280px');
    const handle = container.querySelector('.cursor-col-resize');
    expect(handle).not.toBeNull();
  });

  it('store sidebarWidth 变化 → aside style.width 更新', () => {
    const { container, rerender } = render(<ExplorerSidebar />);
    expect(container.querySelector('aside')!.style.width).toBe('280px');

    useLayoutUiStore.setState({ sidebarWidth: 360 });
    rerender(<ExplorerSidebar />);
    expect(container.querySelector('aside')!.style.width).toBe('360px');
  });
});
