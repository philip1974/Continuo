// @vitest-environment jsdom
// 性能:此前侧栏关闭即卸载整棵文件树 → 每次显隐 toggle 都对每个展开目录 unwatchDir,重开时
// useTree 新实例丢 asyncDataLoader 缓存、根与每个展开目录各 listDir(带 stat)+ watchDir,滚动位置丢失。
// 契约:用户看过的文件树在关闭后保持挂载(aside hidden),重开不重挂;但从未对用户显示过的树
// (启动即关闭 / hydrate 前首帧开、hydrate 后关 / 隐藏期间换了 root)不在隐藏状态下挂载,不做 IO。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ mounts: 0, unmounts: 0, visible: [] as boolean[] }));

vi.mock('../../panels/Explorer/FolderTree', async () => {
  const R = await import('react');
  const { ExplorerVisibleContext } = await import('../../panels/Explorer/visibility');
  return {
    FolderTree: ({ root }: { root: string }) => {
      const visible = R.useContext(ExplorerVisibleContext);
      h.visible.push(visible);
      R.useEffect(() => {
        h.mounts += 1;
        return () => {
          h.unmounts += 1;
        };
      }, []);
      return <div data-testid="folder-tree">{root}</div>;
    },
  };
});

import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  h.mounts = 0;
  h.unmounts = 0;
  h.visible = [];
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
});
afterEach(() => cleanup());

const aside = (c: HTMLElement) => c.querySelector('aside');

describe('ExplorerSidebar · 关闭保持文件树挂载(隐藏)', () => {
  it('开 → 关 → 开:FolderTree 只挂载一次,关闭时 aside hidden 且无拖拽条,可见性经 context 下传', () => {
    const { container } = render(<ExplorerSidebar />);
    expect(h.mounts).toBe(1);
    expect(aside(container)!.hidden).toBe(false);

    act(() => useLayoutUiStore.setState({ sidebarOpen: false }));
    expect(aside(container)).not.toBeNull();
    expect(aside(container)!.hidden).toBe(true);
    expect(container.querySelector('[role=separator]')).toBeNull();
    expect(h.visible.at(-1)).toBe(false);

    act(() => useLayoutUiStore.setState({ sidebarOpen: true }));
    expect(aside(container)!.hidden).toBe(false);
    expect(aside(container)!.style.width).toBe('280px');
    expect(container.querySelector('[role=separator]')).not.toBeNull();
    expect(h.visible.at(-1)).toBe(true);
    expect(h.mounts).toBe(1);
    expect(h.unmounts).toBe(0);
  });

  it('隐藏期间改宽度不重渲文件树;重开后宽度为最新值', () => {
    const { container } = render(<ExplorerSidebar />);
    act(() => useLayoutUiStore.setState({ sidebarOpen: false }));
    const renders = h.visible.length;
    act(() => useLayoutUiStore.setState({ sidebarWidth: 400 }));
    expect(h.visible.length).toBe(renders);
    act(() => useLayoutUiStore.setState({ sidebarOpen: true }));
    expect(aside(container)!.style.width).toBe('400px');
  });

  it('启动即关闭 → 不渲染 aside,不挂载 FolderTree', () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    const { container } = render(<ExplorerSidebar />);
    expect(aside(container)).toBeNull();
    expect(h.mounts).toBe(0);
  });

  it('首帧开(root 未 hydrate)→ hydrate 同批设 root + 关闭:不渲染 aside,不在隐藏态挂载 FolderTree', () => {
    useWorkspaceStore.setState({ root: null });
    const { container } = render(<ExplorerSidebar />);
    act(() => {
      useWorkspaceStore.setState({ root: '/work' });
      useLayoutUiStore.setState({ sidebarOpen: false });
    });
    expect(aside(container)).toBeNull();
    expect(h.mounts).toBe(0);
  });

  it('隐藏期间换 root → 卸载旧树(释放 watcher),不在隐藏态挂载新树;再换回也不挂', () => {
    const { container } = render(<ExplorerSidebar />);
    act(() => useLayoutUiStore.setState({ sidebarOpen: false }));
    act(() => useWorkspaceStore.setState({ root: '/other' }));
    expect(h.unmounts).toBe(1);
    expect(aside(container)).toBeNull();
    act(() => useWorkspaceStore.setState({ root: '/work' }));
    expect(h.mounts).toBe(1);
    expect(aside(container)).toBeNull();

    act(() => useLayoutUiStore.setState({ sidebarOpen: true }));
    expect(h.mounts).toBe(2);
    expect(aside(container)!.hidden).toBe(false);
  });
});
