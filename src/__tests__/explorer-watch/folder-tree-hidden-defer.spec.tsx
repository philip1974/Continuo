// @vitest-environment jsdom
// 性能:Explorer 侧栏关闭时保持挂载但隐藏(ExplorerVisibleContext=false),watcher 仍在。隐藏期间
// 对 dir-changed 立即 invalidate→listDir 是无谓 IO(用户看不见),改为只记脏目录,再次显示时批量刷新。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const fsTree = new Map<string, FileEntry[]>([
  [
    '/work',
    [
      { path: '/work/a', name: 'a', isDirectory: true },
      { path: '/work/b', name: 'b', isDirectory: true },
    ],
  ],
  ['/work/a', [{ path: '/work/a/x.ts', name: 'x.ts', isDirectory: false }]],
  ['/work/b', []],
]);
const dirChanged = vi.hoisted(() => ({ cb: null as null | ((p: string) => void) }));

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
        dirChanged.cb = cb;
        return vi.fn();
      }),
      onWatchLost: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [] }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: vi.fn(async () => ({ ok: true })) }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

import { coApi } from '@/lib/co-api';
import { FolderTree } from '../../panels/Explorer/FolderTree';
import { ExplorerVisibleContext } from '../../panels/Explorer/visibility';

const listed = (p: string) =>
  vi.mocked(coApi.fs.listDir).mock.calls.filter((c) => c[0] === p).length;

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 250)));

function Harness({ visible }: { visible: boolean }) {
  return (
    <ExplorerVisibleContext.Provider value={visible}>
      <FolderTree root="/work" />
    </ExplorerVisibleContext.Provider>
  );
}

async function mountLoaded(expanded: string[]) {
  useExplorerStore.setState({ expandedPaths: new Set(expanded) });
  const r = render(<Harness visible />);
  await waitFor(() => expect(dirChanged.cb).not.toBeNull());
  for (const p of ['/work', ...expanded]) await waitFor(() => expect(listed(p)).toBeGreaterThan(0));
  await settle();
  const base = new Map(['/work', ...expanded].map((p) => [p, listed(p)]));
  return { ...r, delta: (p: string) => listed(p) - (base.get(p) ?? 0) };
}

beforeEach(() => {
  dirChanged.cb = null;
  vi.mocked(coApi.fs.listDir).mockClear();
  vi.mocked(coApi.fs.unwatchDir).mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => cleanup());

describe('FolderTree · 隐藏期间延后 dir-changed 刷新', () => {
  it('隐藏时 dir-changed 不 listDir;再次显示时对脏目录各刷新一次', async () => {
    const { rerender, delta } = await mountLoaded(['/work/a']);
    rerender(<Harness visible={false} />);
    act(() => {
      dirChanged.cb!('/work/a');
    });
    await settle();
    act(() => {
      dirChanged.cb!('/work/a');
      dirChanged.cb!('/work');
    });
    await settle();
    expect(delta('/work/a')).toBe(0);
    expect(delta('/work')).toBe(0);

    rerender(<Harness visible />);
    await waitFor(() => expect(delta('/work/a')).toBe(1));
    await waitFor(() => expect(delta('/work')).toBe(1));
    await settle();
    expect(delta('/work/a')).toBe(1);
  });

  it('隐藏不卸载 watcher(不 unwatchDir、不重新 listDir)', async () => {
    const { rerender, delta } = await mountLoaded(['/work/a']);
    rerender(<Harness visible={false} />);
    await settle();
    rerender(<Harness visible />);
    await settle();
    expect(coApi.fs.unwatchDir).not.toHaveBeenCalled();
    expect(delta('/work')).toBe(0);
    expect(delta('/work/a')).toBe(0);
  });

  it('隐藏期间从未加载的目录变更不记脏(显示时也不 listDir)', async () => {
    const { rerender } = await mountLoaded([]);
    rerender(<Harness visible={false} />);
    act(() => dirChanged.cb!('/work/b'));
    await settle();
    rerender(<Harness visible />);
    await settle();
    expect(listed('/work/b')).toBe(0);
  });

  it('隐藏期间滚动位置被浏览器归零 → 再次显示时恢复为隐藏前的位置', async () => {
    const { container, rerender } = await mountLoaded([]);
    const scroller = container.querySelector('.overflow-auto') as HTMLDivElement;
    scroller.scrollTop = 140;
    fireEvent.scroll(scroller);
    rerender(<Harness visible={false} />);
    scroller.scrollTop = 0; // 模拟 display:none 丢失滚动偏移
    fireEvent.scroll(scroller); // 隐藏期间的 scroll 事件不覆盖记录
    rerender(<Harness visible />);
    expect(scroller.scrollTop).toBe(140);
  });

  it('可见时 dir-changed 照常立即刷新', async () => {
    const { delta } = await mountLoaded(['/work/a']);
    act(() => dirChanged.cb!('/work/a'));
    await waitFor(() => expect(delta('/work/a')).toBe(1));
  });
});
