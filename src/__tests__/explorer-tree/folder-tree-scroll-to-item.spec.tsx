// @vitest-environment jsdom
// 键盘导航跳到虚拟窗口外(End / Home / 深层 ArrowLeft 回父目录):headless-tree updateDomFocus 先调
// config.scrollToItem,再轮询最多 500ms 等目标行挂载,超时把焦点打回首项。未配置 scrollToItem 时
// 虚拟列表不会滚动 → 目标行永远不挂载 → 焦点回首项。
// 契约:scrollToItem → virtualizer.scrollToIndex(目标在「实际渲染的 items」(隐藏文件过滤后)中的下标,
// { align: 'auto' });焦点最终落在目标行。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const h = vi.hoisted(() => ({
  range: { start: 0, end: 10 },
  setTick: null as null | ((fn: (n: number) => number) => void),
  scrollToIndex: null as null | ((index: number, opts?: unknown) => void),
  showHidden: false,
  editorFile: { openFileByPath: async () => ({ ok: true }) },
}));

// 5 个隐藏文件排在最前:过滤后下标与 headless-tree 的 getItemMeta().index 相差 5
const hidden: FileEntry[] = Array.from({ length: 5 }, (_, i) => ({
  path: `/work/.h${i}`,
  name: `.h${i}`,
  isDirectory: false,
}));
const files: FileEntry[] = Array.from({ length: 60 }, (_, i) => ({
  path: `/work/f${String(i).padStart(2, '0')}.ts`,
  name: `f${String(i).padStart(2, '0')}.ts`,
  isDirectory: false,
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: p === '/work' ? [...hidden, ...files] : [] })),
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
      onRootPresenceChanged: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
// 可控 virtualizer:只渲染 range 内的行;scrollToIndex 把 range 移到目标附近并触发重渲(模拟真实滚动)
vi.mock('@tanstack/react-virtual', async () => {
  const R = await import('react');
  return {
    useVirtualizer: (opts: { count: number }) => {
      const [, setTick] = R.useState(0);
      h.setTick = setTick;
      return {
        getTotalSize: () => opts.count * 28,
        getVirtualItems: () => {
          const out = [];
          for (let i = h.range.start; i < Math.min(h.range.end, opts.count); i++) {
            out.push({ index: i, start: i * 28, size: 28, key: i });
          }
          return out;
        },
        scrollToIndex: (index: number, o?: unknown) => {
          h.scrollToIndex?.(index, o);
          h.range = { start: Math.max(0, index - 5), end: index + 5 };
          setTick((n) => n + 1);
        },
      };
    },
  };
});
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => h.editorFile,
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (key: string, fallback: unknown) =>
    key === 'explorer.showHiddenFiles' ? h.showHidden : fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { FolderTree } from '../../panels/Explorer/FolderTree';

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;

async function pressEndFrom(first: string) {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, first)).not.toBeNull());
  act(() => {
    fireEvent.click(row(r.container, first)!);
  });
  await waitFor(() => expect(row(r.container, first)!.getAttribute('tabindex')).toBe('0'));
  act(() => {
    fireEvent.keyDown(row(r.container, first)!, { key: 'End', code: 'End' });
  });
  return r;
}

beforeEach(() => {
  h.range = { start: 0, end: 10 };
  h.scrollToIndex = vi.fn();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => cleanup());

describe('FolderTree · scrollToItem 接 virtualizer', () => {
  it('隐藏文件过滤下按 End → scrollToIndex(过滤后数组下标, align auto),焦点落在末项', async () => {
    h.showHidden = false;
    const { container } = await pressEndFrom('/work/f00.ts');
    const last = '/work/f59.ts';
    await waitFor(() => expect(h.scrollToIndex).toHaveBeenCalledWith(59, { align: 'auto' }));
    await waitFor(() => expect(document.activeElement).toBe(row(container, last)));
    expect(row(container, last)!.getAttribute('tabindex')).toBe('0');
  });

  it('显示隐藏文件时按 End → 下标含隐藏项(64)', async () => {
    h.showHidden = true;
    const { container } = await pressEndFrom('/work/.h0');
    const last = '/work/f59.ts';
    await waitFor(() => expect(h.scrollToIndex).toHaveBeenCalledWith(64, { align: 'auto' }));
    await waitFor(() => expect(document.activeElement).toBe(row(container, last)));
  });
});

// 拖放结束:headless-tree 行 onDrop 在 onDrop / onDropForeignDragObject 之后 draggedItems[0].setFocused()
// + updateDomFocus()(setTimeout 内调 scrollToItem;无焦点时回退首项)。若照单滚动,长列表拖到下方目录 /
// 从 Finder 拖入后列表会跳回源行或首项。契约:drop 引起的那一次 scrollToItem 不滚;之后键盘导航照常滚。
const filesDT = () => ({ types: ['Files'], items: [], files: [] });
const flushTimers = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

describe('FolderTree · 拖放结束不触发滚动', () => {
  it('内部拖动 drop 到另一行 → 不 scrollToIndex;之后按 End 仍 scrollToIndex', async () => {
    h.showHidden = false;
    const { container } = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(container, '/work/f00.ts')).not.toBeNull());
    act(() => {
      fireEvent.click(row(container, '/work/f00.ts')!);
    });
    act(() => {
      fireEvent.dragStart(row(container, '/work/f00.ts')!, { dataTransfer: { types: [], setData: () => {} } });
    });
    await act(async () => {
      // 内部拖动:真实浏览器 drop 事件总带 dataTransfer(无 Files 类型)
      fireEvent.drop(row(container, '/work/f05.ts')!, { dataTransfer: { types: [] } });
    });
    await flushTimers();
    expect(h.scrollToIndex).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(row(container, '/work/f00.ts')!, { key: 'End', code: 'End' });
    });
    await waitFor(() => expect(h.scrollToIndex).toHaveBeenCalledWith(59, { align: 'auto' }));
  });

  it('OS 文件 drop 到某行(无焦点回退首项)→ 不 scrollToIndex;之后键盘导航仍滚动', async () => {
    // 显示隐藏文件:回退的首项 .h0 在渲染列表中(否则下标找不到本就不滚,测不出)
    h.showHidden = true;
    const { container } = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(container, '/work/f00.ts')).not.toBeNull());
    await act(async () => {
      fireEvent.drop(row(container, '/work/f03.ts')!, { dataTransfer: filesDT() });
    });
    await flushTimers();
    expect(h.scrollToIndex).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(row(container, '/work/.h0')!);
    });
    act(() => {
      fireEvent.keyDown(row(container, '/work/.h0')!, { key: 'End', code: 'End' });
    });
    await waitFor(() => expect(h.scrollToIndex).toHaveBeenCalledWith(64, { align: 'auto' }));
  });

  it('drop 回调触发但库未调用 scrollToItem(容器级 drop 不 updateDomFocus)→ 一次性标志不残留,之后键盘导航仍滚动', async () => {
    h.showHidden = true;
    const { container } = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(container, '/work/.h0')).not.toBeNull());
    await act(async () => {
      fireEvent.drop(container.querySelector('[role="tree"]')!, { dataTransfer: filesDT() });
    });
    await flushTimers();
    act(() => {
      fireEvent.click(row(container, '/work/.h0')!);
    });
    act(() => {
      fireEvent.keyDown(row(container, '/work/.h0')!, { key: 'End', code: 'End' });
    });
    await waitFor(() => expect(h.scrollToIndex).toHaveBeenCalledWith(64, { align: 'auto' }));
  });
});

// 只跳过滚动还不够:库 updateDomFocus 在 scrollToItem 后轮询 500ms 等焦点项挂载,取不到就把焦点重置到首项
// (内部移动时焦点项是源行,长列表里往往已滚出窗口;OS 文件拖入时焦点项可能也不在窗口内)。下一次方向键
// 从首项出发 → scrollToItem(首项邻居) → 列表跳回顶部。契约:drop 后焦点落在实际松手的那一行(已渲染),
// 列表不动;之后方向键从该行继续。
const scrollTo = (start: number) =>
  act(() => {
    h.range = { start, end: start + 10 };
    h.setTick?.((n) => n + 1);
  });

describe('FolderTree · 长列表 drop 后焦点落在松手行', () => {
  it('内部拖动:源行已滚出窗口,drop 到下方某行 → 焦点在该行,列表不跳回;ArrowDown 从该行继续', async () => {
    h.showHidden = false;
    const { container } = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(container, '/work/f00.ts')).not.toBeNull());
    act(() => {
      fireEvent.click(row(container, '/work/f00.ts')!);
    });
    act(() => {
      fireEvent.dragStart(row(container, '/work/f00.ts')!, { dataTransfer: { types: [], setData: () => {} } });
    });
    scrollTo(40);
    expect(row(container, '/work/f00.ts')).toBeNull();
    await act(async () => {
      fireEvent.drop(row(container, '/work/f45.ts')!, { dataTransfer: { types: [] } });
    });
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/f45.ts')), {
      timeout: 1500,
    });
    // 等过库 500ms 轮询窗口:焦点不被重置到首项
    await act(() => new Promise<void>((r) => setTimeout(r, 600)));
    expect(document.activeElement).toBe(row(container, '/work/f45.ts'));
    expect(h.scrollToIndex).not.toHaveBeenCalled();
    expect(h.range.start).toBe(40);

    act(() => {
      fireEvent.keyDown(row(container, '/work/f45.ts')!, { key: 'ArrowDown', code: 'ArrowDown' });
    });
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/f46.ts')));
    // 方向键照常 scrollToItem(mock 会把邻行居中),但不会跳回顶部
    expect(h.range.start).toBeGreaterThan(30);
  });

  it('OS 文件拖入:drop 到窗口内某行 → 焦点在该行(不回退首项);ArrowDown 从该行继续', async () => {
    h.showHidden = false;
    const { container } = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(container, '/work/f00.ts')).not.toBeNull());
    scrollTo(40);
    await act(async () => {
      fireEvent.drop(row(container, '/work/f43.ts')!, { dataTransfer: filesDT() });
    });
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/f43.ts')), {
      timeout: 1500,
    });
    await act(() => new Promise<void>((r) => setTimeout(r, 600)));
    expect(document.activeElement).toBe(row(container, '/work/f43.ts'));
    expect(h.range.start).toBe(40);

    act(() => {
      fireEvent.keyDown(row(container, '/work/f43.ts')!, { key: 'ArrowDown', code: 'ArrowDown' });
    });
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/f44.ts')));
    // 方向键照常 scrollToItem(mock 会把邻行居中),但不会跳回顶部
    expect(h.range.start).toBeGreaterThan(30);
  });
});
