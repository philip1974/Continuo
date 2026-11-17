// @vitest-environment jsdom
// OS 文件 drop 到具体行:headless-tree 行 onDrop 先 e.stopPropagation() → 外层容器 onDrop(复位 dragActive
// 的地方)收不到;浏览器 drop 后不再派发 dragleave → DropOverlay 残留到下一次拖拽。
// 契约:无论 drop 落在行上还是空白处,drop 后 DropOverlay 消失、拖拽计数归零(下一次拖入正常出现/消失)。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';
import { flushSync } from 'react-dom';

const h = vi.hoisted(() => ({ dropInto: vi.fn(async (..._args: unknown[]) => {}) }));

const files: FileEntry[] = [
  { path: '/work/dir', name: 'dir', isDirectory: true },
  ...Array.from({ length: 5 }, (_, i) => ({
    path: `/work/f${i}.ts`,
    name: `f${i}.ts`,
    isDirectory: false,
  })),
];

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: p === '/work' ? files : [] })),
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      writeBinary: vi.fn(async () => ({ ok: true })),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 28,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => {
  const editorFile = { openFileByPath: async () => ({ ok: true }) };
  return { useEditorFile: () => editorFile };
});
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/batch-transfer', async (orig) => ({
  ...(await orig<typeof import('../../panels/Explorer/batch-transfer')>()),
  dropForeignFilesInto: h.dropInto,
}));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { FolderTree } from '../../panels/Explorer/FolderTree';

const row = (container: HTMLElement, p: string) =>
  container.querySelector(`[title="${p}"]`) as HTMLElement | null;
const overlay = (container: HTMLElement) => container.querySelector('.border-dashed');
const filesDT = () => ({ types: ['Files'], items: [], files: [] });
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

beforeEach(() => {
  h.dropInto.mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => cleanup());

async function mount() {
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(row(r.container, '/work/f0.ts')).not.toBeNull());
  return r;
}

describe('FolderTree · OS 文件 drop 后 DropOverlay 复位', () => {
  it('drop 到目录行 → overlay 消失', async () => {
    const { container } = await mount();
    act(() => {
      fireEvent.dragEnter(row(container, '/work/dir')!, { dataTransfer: filesDT() });
    });
    expect(overlay(container)).not.toBeNull();
    await act(async () => {
      fireEvent.drop(row(container, '/work/dir')!, { dataTransfer: filesDT() });
    });
    await flush();
    expect(overlay(container)).toBeNull();
  });

  it('drop 到行后再次拖入并离开 → overlay 随之出现并消失(拖拽计数已归零)', async () => {
    const { container } = await mount();
    const target = row(container, '/work/f1.ts')!;
    act(() => {
      fireEvent.dragEnter(target, { dataTransfer: filesDT() });
    });
    await act(async () => {
      fireEvent.drop(target, { dataTransfer: filesDT() });
    });
    await flush();
    act(() => {
      fireEvent.dragEnter(target, { dataTransfer: filesDT() });
    });
    expect(overlay(container)).not.toBeNull();
    act(() => {
      fireEvent.dragLeave(target, { dataTransfer: filesDT() });
    });
    expect(overlay(container)).toBeNull();
  });
});

// 真实浏览器:React 19 在根容器分别挂捕获 / 冒泡两个原生监听,drop 是离散事件,捕获阶段 setState 在
// microtask 中 flush;浏览器在每个监听回调之间做 microtask checkpoint → 冒泡阶段组件已按复位后的状态重渲,
// handleDrop 若读渲染闭包里的 hoverTarget 拿到的是 null → 落点退化为 root,与 DropOverlay 显示的目录不一致。
// jsdom 同步派发无 checkpoint:在 at-target 原生监听(位于根捕获之后、根冒泡之前)里 flushSync 模拟它。
describe('FolderTree · OS 文件 drop 到空白处的落点(捕获/冒泡间 microtask checkpoint)', () => {
  it('拖过目录行后在空白处松手 → 落点 = DropOverlay 显示的该目录,而非 root', async () => {
    const { container } = await mount();
    act(() => {
      fireEvent.dragEnter(row(container, '/work/dir')!, { dataTransfer: filesDT() });
    });
    expect(overlay(container)).not.toBeNull();

    const blank = container.querySelector('.overflow-auto') as HTMLElement;
    const checkpoint = () => flushSync(() => {});
    blank.addEventListener('drop', checkpoint);
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: filesDT() });
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prevAct = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false; // 脱离 act 批处理,让 flushSync 真正在两阶段之间 flush
    try {
      blank.dispatchEvent(ev);
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = prevAct;
      blank.removeEventListener('drop', checkpoint);
    }
    await flush();
    expect(h.dropInto).toHaveBeenCalledTimes(1);
    expect(h.dropInto.mock.calls[0]![1]).toBe('/work/dir');
    expect(overlay(container)).toBeNull();
  });
});
