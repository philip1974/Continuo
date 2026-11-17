// @vitest-environment jsdom
// 性能:滚动时 virtualizer 每跨一行(28px)经 flushSync 同步重渲整个 FolderTree。FileRow 若不 memo
// (每行带 Radix ContextMenu Root+Trigger 十余层),每次都把约 56 个可见行全部重渲。
// 契约:range 变化时未进出视口的行不重渲;行自身状态(选中/聚焦/展开/重命名/剪切)变化时该行重渲且
// DOM 反映新状态。行渲染计数用 ContextMenu 探针(FileRow 每次渲染都创建一个,target=该行 entry)。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const ROW = 28;
const h = vi.hoisted(() => ({
  renders: new Map<string, number>(),
  range: { start: 0, end: 10 },
  setTick: null as null | ((fn: (n: number) => number) => void),
  // 生产 useEditorFile 返回 useMemo 稳定对象;mock 也须稳定,否则 onFileOpen 每次换引用击穿 memo。
  dirChanged: null as null | ((p: string) => void),
  editorFile: { openFileByPath: async () => ({ ok: true }) },
}));

const files: FileEntry[] = [
  { path: '/work/dir', name: 'dir', isDirectory: true },
  ...Array.from({ length: 40 }, (_, i) => ({
    path: `/work/f${String(i).padStart(2, '0')}.ts`,
    name: `f${String(i).padStart(2, '0')}.ts`,
    isDirectory: false,
  })),
];
const fsTree = new Map<string, FileEntry[]>([
  ['/work', files],
  ['/work/dir', [{ path: '/work/dir/inner.ts', name: 'inner.ts', isDirectory: false }]],
]);

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn((cb: (p: string) => void) => {
        h.dirChanged = cb;
        return vi.fn();
      }),
      onWatchLost: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
// 可控 virtualizer:range 由测试设定,setTick 模拟滚动触发的 FolderTree 重渲。
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
      };
    },
  };
});
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => h.editorFile,
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));
vi.mock('../../panels/Explorer/ContextMenu', () => ({
  ContextMenu: ({
    children,
    target,
  }: {
    children?: React.ReactNode;
    target: FileEntry | null;
  }) => {
    if (target) h.renders.set(target.path, (h.renders.get(target.path) ?? 0) + 1);
    return children ?? null;
  },
}));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';

const fname = (i: number) => `/work/f${String(i).padStart(2, '0')}.ts`;
const count = (p: string) => h.renders.get(p) ?? 0;
const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;

async function mount() {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, fname(0))).not.toBeNull());
  return r;
}

beforeEach(() => {
  h.renders.clear();
  h.range = { start: 0, end: 10 };
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
});
afterEach(() => cleanup());

describe('FolderTree · FileRow memo', () => {
  it('滚动(range 变化)→ 仍在视口的行不重渲,新进入的行渲染,定位正确', async () => {
    const { container } = await mount();
    const before = new Map(h.renders);

    act(() => {
      h.range = { start: 3, end: 13 };
      h.setTick!((n) => n + 1);
    });

    // index 3..9 一直在视口:不重渲
    for (let i = 2; i <= 8; i++) expect(count(fname(i))).toBe(before.get(fname(i)));
    // index 10..12 新进入:渲染一次,transform 按 start 构造
    expect(count(fname(10))).toBe(1);
    expect(row(container, fname(10))!.style.transform).toBe(`translateY(${11 * ROW}px)`);
    // 离开视口的行已卸载
    expect(row(container, fname(0))).toBeNull();
  });

  it('选中 → 该行重渲且 aria-selected=true', async () => {
    const { container } = await mount();
    const target = row(container, fname(2))!;
    const before = count(fname(2));
    act(() => {
      fireEvent.click(target);
    });
    await waitFor(() => expect(row(container, fname(2))!.getAttribute('aria-selected')).toBe('true'));
    expect(count(fname(2))).toBeGreaterThan(before);
  });

  it('键盘移动焦点 → 只有新旧焦点行重渲,tabIndex 跟随', async () => {
    const { container } = await mount();
    act(() => {
      fireEvent.click(row(container, fname(1))!);
    });
    await waitFor(() => expect(row(container, fname(1))!.getAttribute('tabindex')).toBe('0'));
    const before = new Map(h.renders);
    act(() => {
      fireEvent.keyDown(row(container, fname(1))!, { key: 'ArrowDown', code: 'ArrowDown' });
    });
    await waitFor(() => expect(row(container, fname(2))!.getAttribute('tabindex')).toBe('0'));
    expect(row(container, fname(1))!.getAttribute('tabindex')).toBe('-1');
    expect(count(fname(2))).toBeGreaterThan(before.get(fname(2))!);
    // 无关行不重渲
    expect(count(fname(5))).toBe(before.get(fname(5)));
  });

  it('展开目录 → 该行 aria-expanded=true,箭头切换', async () => {
    const { container } = await mount();
    const dir = row(container, '/work/dir')!;
    expect(dir.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      fireEvent.click(dir);
    });
    await waitFor(() => expect(row(container, '/work/dir')!.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(row(container, '/work/dir/inner.ts')).not.toBeNull());
    expect(row(container, '/work/dir')!.textContent).toContain('▾');
  });

  it('剪切 → 被剪切行灰显,其它行不重渲', async () => {
    // 剪贴板已非空(hasClipboard 已为 true):空↔非空翻转会让每行 ContextMenu 的「粘贴」可见性
    // 变化,属于预期的全行重渲;这里验证的是非空态下剪切集变化只影响相关行。
    useExplorerClipboardStore.setState({ kind: 'copy', paths: [fname(9)] });
    const { container } = await mount();
    const before = new Map(h.renders);
    act(() => {
      useExplorerClipboardStore.getState().set('cut', [fname(3)]);
    });
    expect(row(container, fname(3))!.className).toContain('opacity-50');
    expect(row(container, fname(4))!.className).not.toContain('opacity-50');
    expect(count(fname(5))).toBe(before.get(fname(5)));
  });

  it('兄弟增删 → 未变数据的行 aria-setsize 仍更新(posInSet/setSize 是 memo 失效键)', async () => {
    const { container } = await mount();
    expect(row(container, fname(0))!.getAttribute('aria-setsize')).toBe('41');
    fsTree.set('/work', [...files, { path: '/work/zz.ts', name: 'zz.ts', isDirectory: false }]);
    try {
      act(() => h.dirChanged!('/work'));
      await waitFor(() => expect(row(container, fname(0))!.getAttribute('aria-setsize')).toBe('42'));
    } finally {
      fsTree.set('/work', files);
    }
  });

  it('重命名 → 该行出现输入框,输入值受控更新', async () => {
    const { container } = await mount();
    act(() => {
      fireEvent.click(row(container, fname(2))!);
    });
    act(() => {
      fireEvent.keyDown(row(container, fname(2))!, { key: 'F2', code: 'F2' });
    });
    const input = await waitFor(() => {
      const el = container.querySelector('input');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    expect(input.value).toBe('f02.ts');
    act(() => {
      fireEvent.change(input, { target: { value: 'g.ts' } });
    });
    await waitFor(() => expect((container.querySelector('input') as HTMLInputElement).value).toBe('g.ts'));
  });
});
