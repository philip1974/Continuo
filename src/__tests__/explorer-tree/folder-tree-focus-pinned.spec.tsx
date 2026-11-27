// @vitest-environment jsdom
// 鼠标滚轮把焦点行滚出视口:虚拟列表若按可视窗口卸载它,DOM 焦点掉到 body,↓ / Shift+F10 / ⌘C / Delete 全部失效。
// VSCode 列表滚动不丢 DOM 焦点。契约(照 TanStack sticky / headless-tree 虚拟化示例):virtualizer 的 rangeExtractor
// 在 defaultRangeExtractor 结果中并入焦点行下标(升序去重)→ 焦点行始终渲染,滚动后 DOM 焦点仍在该行,方向键照常移动。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Range } from '@tanstack/react-virtual';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';
import { rangeWithPinnedIndex } from '../../lib/virtual-range';

const h = vi.hoisted(() => ({
  range: { start: 0, end: 10 },
  setTick: null as null | ((fn: (n: number) => number) => void),
}));

const files: FileEntry[] = Array.from({ length: 200 }, (_, i) => ({
  path: `/work/f${String(i).padStart(3, '0')}.ts`,
  name: `f${String(i).padStart(3, '0')}.ts`,
  isDirectory: false,
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: p === '/work' ? files : [] })),
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
// 可控 virtualizer:可视窗口 = h.range(模拟滚动),渲染下标经调用方的 rangeExtractor(缺省 = 默认连续窗口)。
vi.mock('@tanstack/react-virtual', async () => {
  const R = await import('react');
  const actual = await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
  return {
    ...actual,
    useVirtualizer: (opts: { count: number; rangeExtractor?: (r: Range) => number[] }) => {
      const [, setTick] = R.useState(0);
      h.setTick = setTick;
      const extract = opts.rangeExtractor ?? actual.defaultRangeExtractor;
      return {
        getTotalSize: () => opts.count * 22,
        getVirtualItems: () => {
          if (opts.count === 0) return [];
          const range: Range = {
            startIndex: h.range.start,
            endIndex: Math.min(h.range.end, opts.count) - 1,
            overscan: 0,
            count: opts.count,
          };
          return extract(range).map((i) => ({ index: i, start: i * 22, size: 22, key: i, end: i * 22 + 22, lane: 0 }));
        },
        scrollToIndex: (index: number) => {
          if (index >= h.range.start && index < h.range.end) return;
          h.range = { start: Math.max(0, index - 5), end: index + 5 };
          setTick((n) => n + 1);
        },
      };
    },
  };
});
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: async () => ({ ok: true }) }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { FolderTree } from '../../panels/Explorer/FolderTree';

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;
/** 模拟滚轮:可视窗口移到 [start, start+10),不经键盘 / 焦点变化。 */
const wheelTo = (start: number) =>
  act(() => {
    h.range = { start, end: start + 10 };
    h.setTick?.((n) => n + 1);
  });

beforeEach(() => {
  h.range = { start: 0, end: 10 };
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => cleanup());

describe('rangeWithPinnedIndex', () => {
  const r = (startIndex: number, endIndex: number, count = 100): Range => ({ startIndex, endIndex, overscan: 2, count });
  it('pinned 在窗口前 / 后 → 并入且保持升序', () => {
    expect(rangeWithPinnedIndex(r(10, 12), 3)).toEqual([3, 8, 9, 10, 11, 12, 13, 14]);
    expect(rangeWithPinnedIndex(r(10, 12), 50)).toEqual([8, 9, 10, 11, 12, 13, 14, 50]);
  });
  it('pinned 已在窗口内 → 不重复', () => {
    expect(rangeWithPinnedIndex(r(10, 12), 9)).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });
  it('默认窗口与库的 defaultRangeExtractor 逐项一致(含首尾截断)', async () => {
    const actual = await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
    for (const range of [r(10, 12), r(0, 3), r(95, 99), r(0, 0, 1), r(5, 9, 10)]) {
      expect(rangeWithPinnedIndex(range, -1)).toEqual(actual.defaultRangeExtractor(range));
    }
  });
  it('pinned 越界(-1 / ≥ count)→ 原样默认窗口', () => {
    expect(rangeWithPinnedIndex(r(10, 12), -1)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(rangeWithPinnedIndex(r(10, 12, 20), 20)).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });
});

describe('FolderTree · 焦点行滚出视口仍渲染', () => {
  async function clickFirst() {
    const r = render(<FolderTree root="/work" />);
    await waitFor(() => expect(row(r.container, '/work/f000.ts')).not.toBeNull());
    act(() => {
      // 真实浏览器 mousedown 把 DOM 焦点给可聚焦行;jsdom 的 click 不会 → 显式 focus
      fireEvent.click(row(r.container, '/work/f000.ts')!);
      row(r.container, '/work/f000.ts')!.focus();
    });
    await waitFor(() => expect(document.activeElement).toBe(row(r.container, '/work/f000.ts')));
    return r;
  }

  it('滚轮滚到远处 → 焦点行仍在 DOM、DOM 焦点不掉到 body', async () => {
    const { container } = await clickFirst();
    wheelTo(100);
    const focused = row(container, '/work/f000.ts');
    expect(focused).not.toBeNull();
    expect(focused!.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(focused);
    // 可视窗口的行照常渲染
    expect(row(container, '/work/f100.ts')).not.toBeNull();
  });

  it('滚出视口后按 ↓ → 焦点移到下一行(列表滚回焦点处)', async () => {
    const { container } = await clickFirst();
    wheelTo(100);
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', code: 'ArrowDown' });
    });
    await waitFor(() => expect(document.activeElement).toBe(row(container, '/work/f001.ts')));
  });
});
