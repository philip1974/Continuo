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
