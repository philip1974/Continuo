// @vitest-environment jsdom
// macOS/Win 根目录 recursive watcher 对任意深度变更上报其所在目录(含 .git / node_modules 等
// listDir 默认排除、树上不显示的目录)。headless-tree 的 getItemInstance 对未知 id 现建临时实例,
// invalidateChildrenIds 会对从未加载过的目录照样 listDir + 写缓存 + rebuildTree。
// 契约:从未加载过子项的非 root 目录变更不触发 listDir;已加载(含已折叠但缓存的)目录与 root 照常刷新。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
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

const listed = (p: string) =>
  vi.mocked(coApi.fs.listDir).mock.calls.filter((c) => c[0] === p).length;

// 越过 useFsWatcher 的 100ms per-path debounce 与随后的异步加载
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 250)));

// 挂载并等首轮加载稳定;返回各路径的基线 listDir 次数(挂载期次数随 StrictMode/重渲而定,不钉死)
async function mountLoaded(expanded: string[] = []): Promise<(p: string) => number> {
  useExplorerStore.setState({ expandedPaths: new Set(expanded) });
  render(<FolderTree root="/work" />);
  await waitFor(() => expect(dirChanged.cb).not.toBeNull());
  await waitFor(() => expect(listed('/work')).toBeGreaterThan(0));
  for (const p of expanded) await waitFor(() => expect(listed(p)).toBeGreaterThan(0));
  await settle();
  const base = new Map(['/work', ...expanded].map((p) => [p, listed(p)]));
  return (p) => listed(p) - (base.get(p) ?? 0);
}

beforeEach(() => {
  dirChanged.cb = null;
  vi.mocked(coApi.fs.listDir).mockClear();
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
});

afterEach(() => {
  cleanup();
});

describe('FolderTree · dir-changed 跳过从未加载子项的目录', () => {
  it('树上不显示的目录(.git / node_modules)变更不触发 listDir', async () => {
    await mountLoaded();
    act(() => {
      dirChanged.cb!('/work/.git');
      dirChanged.cb!('/work/node_modules/pkg/dist');
    });
    await settle();
    expect(listed('/work/.git')).toBe(0);
    expect(listed('/work/node_modules/pkg/dist')).toBe(0);
  });

  it('已显示但从未展开过的目录变更不触发 listDir', async () => {
    await mountLoaded();
    act(() => dirChanged.cb!('/work/b'));
    await settle();
    expect(listed('/work/b')).toBe(0);
  });

  it('root 变更照常刷新', async () => {
    const delta = await mountLoaded();
    act(() => dirChanged.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(1));
  });

  it('已加载的展开目录变更照常刷新', async () => {
    const delta = await mountLoaded(['/work/a']);
    act(() => dirChanged.cb!('/work/a'));
    await waitFor(() => expect(delta('/work/a')).toBe(1));
  });

  it('已加载后折叠(子项仍缓存)的目录变更照常刷新', async () => {
    const delta = await mountLoaded(['/work/a']);
    act(() => useExplorerStore.setState({ expandedPaths: new Set() }));
    await settle();
    act(() => dirChanged.cb!('/work/a'));
    await waitFor(() => expect(delta('/work/a')).toBe(1));
  });
});
