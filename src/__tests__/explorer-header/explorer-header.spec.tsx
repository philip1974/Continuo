// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { ExplorerHeader } from '../../panels/Explorer/ExplorerHeader';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';

function installFs(selectDirectory: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    value: { fs: { selectDirectory } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  useWorkspaceStore.setState({ root: '/proj', recentRoots: ['/proj'] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('ExplorerHeader — 标题', () => {
  it('显示 basename(root) + title=完整路径', () => {
    installFs(vi.fn());
    const { container } = render(
      <ExplorerHeader root="/Users/foo/projects/myapp" />,
    );
    const title = container.querySelector('span[title]') as HTMLElement;
    expect(title.textContent).toBe('myapp');
    expect(title.getAttribute('title')).toBe('/Users/foo/projects/myapp');
  });
});

describe('ExplorerHeader — Hover 工具条', () => {
  it('callbacks 缺 → 不渲染对应按钮', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    expect(container.querySelector('button[aria-label=新建文件]')).toBeNull();
    expect(container.querySelector('button[aria-label=新建文件夹]')).toBeNull();
    expect(container.querySelector('button[aria-label=刷新]')).toBeNull();
    expect(container.querySelector('button[aria-label=折叠全部]')).toBeNull();
  });

  it('onNewFile 提供 → 点击调 fn', () => {
    installFs(vi.fn());
    const onNewFile = vi.fn();
    const { container } = render(
      <ExplorerHeader root="/proj" onNewFile={onNewFile} />,
    );
    fireEvent.click(
      container.querySelector('button[aria-label=新建文件]') as HTMLButtonElement,
    );
    expect(onNewFile).toHaveBeenCalledTimes(1);
  });

  it('onNewDir / onRefresh / onCollapseAll 同模式', () => {
    installFs(vi.fn());
    const onNewDir = vi.fn();
    const onRefresh = vi.fn();
    const onCollapseAll = vi.fn();
    const { container } = render(
      <ExplorerHeader
        root="/proj"
        onNewDir={onNewDir}
        onRefresh={onRefresh}
        onCollapseAll={onCollapseAll}
      />,
    );
    fireEvent.click(
      container.querySelector(
        'button[aria-label=新建文件夹]',
      ) as HTMLButtonElement,
    );
    fireEvent.click(
      container.querySelector('button[aria-label=刷新资源管理器]') as HTMLButtonElement,
    );
    fireEvent.click(
      container.querySelector(
        'button[aria-label=折叠全部]',
      ) as HTMLButtonElement,
    );
    expect(onNewDir).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });
});

describe('ExplorerHeader — ⋯ 菜单', () => {
  it('默认关闭', () => {
    installFs(vi.fn());
    render(<ExplorerHeader root="/proj" />);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('点 ⋯ → 打开;再点 → 关', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    const moreBtn = container.querySelector(
      'button[aria-label=更多操作]',
    ) as HTMLButtonElement;
    fireEvent.click(moreBtn);
    expect(document.querySelector('[role=menu]')).not.toBeNull();
    fireEvent.click(moreBtn);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('「展开全部」disabled=!onExpandAll', () => {
    installFs(vi.fn());
    const { container, rerender } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    let expandItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '展开全部')!;
    expect(expandItem.disabled).toBe(true);

    rerender(
      <ExplorerHeader root="/proj" onExpandAll={vi.fn()} />,
    );
    expandItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '展开全部')!;
    expect(expandItem.disabled).toBe(false);
  });

  it('点「展开全部」→ onExpandAll + 关菜单', () => {
    installFs(vi.fn());
    const onExpandAll = vi.fn();
    const { container } = render(
      <ExplorerHeader root="/proj" onExpandAll={onExpandAll} />,
    );
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const expandItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '展开全部')!;
    fireEvent.click(expandItem);
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('点「关闭文件夹」 → setRoot(null) + 关菜单', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const closeItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '关闭文件夹')!;
    fireEvent.click(closeItem);
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it('点「切换文件夹…」 → selectDirectory ok=true + setRoot', async () => {
    const selectDirectory = vi
      .fn()
      .mockResolvedValue({ ok: true, data: '/picked' });
    installFs(selectDirectory);
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const switchItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent === '切换文件夹…')!;
    fireEvent.click(switchItem);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().root).toBe('/picked');
    });
  });

  it('文档 pointerdown 在 wrap 外 → 关菜单', () => {
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    expect(document.querySelector('[role=menu]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(document.querySelector('[role=menu]')).toBeNull();
  });
});

describe('ExplorerHeader — 最近打开列表', () => {
  it('recentOthers 空(只有当前)→ 不渲染「打开最近」', () => {
    useWorkspaceStore.setState({ root: '/proj', recentRoots: ['/proj'] });
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    expect(document.querySelector('[role=menu]')!.textContent).not.toContain(
      '打开最近',
    );
  });

  it('recentOthers 非空 → 列出 basename,点击 setRoot', () => {
    useWorkspaceStore.setState({
      root: '/proj',
      recentRoots: ['/proj', '/Users/foo/older'],
    });
    installFs(vi.fn());
    const { container } = render(<ExplorerHeader root="/proj" />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label=更多操作]',
      ) as HTMLButtonElement,
    );
    const olderItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
    ).find((b) => b.textContent?.trim() === 'older')!;
    expect(olderItem).toBeDefined();
    fireEvent.click(olderItem);
    expect(useWorkspaceStore.getState().root).toBe('/Users/foo/older');
  });
});
