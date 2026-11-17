// @vitest-environment jsdom
// 性能:原子保存(本应用 / vim / VSCode 写 tmp 再 rename 覆盖)只产生 rename 事件,dir-changed 不是
// changeOnly → Explorer 刷新所在目录。listDir 本身便宜,贵的是 headless-tree 整树 rebuild。
// 契约:目录刷新先 listDir,与已缓存子项比较(顺序 + path + name + isDirectory + isSymlink;size/mtime
// 不显示且按 FileEntry 契约是快照,不比较)。完全相同 → 不 invalidate / 不 rebuild;不同 → 直接用这次
// listDir 结果更新缓存并 rebuild 一次(不二次 listDir)。并发刷新只应用最后一次;卸载后结果丢弃。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { TreeInstance } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const fsTree = new Map<string, FileEntry[]>();
function resetFs(): void {
  fsTree.clear();
  fsTree.set('/work', [
    { path: '/work/a', name: 'a', isDirectory: true },
    { path: '/work/a.md', name: 'a.md', isDirectory: false, size: 1, mtime: 1 },
  ]);
  fsTree.set('/work/a', [{ path: '/work/a/x.ts', name: 'x.ts', isDirectory: false }]);
}
const hoisted = vi.hoisted(() => ({
  cb: null as null | ((p: string) => void),
  tree: null as unknown,
}));

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
        hoisted.cb = cb;
        return vi.fn();
      }),
      onWatchLost: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));

vi.mock('@headless-tree/react', async (importOriginal) => {
  const m = await importOriginal<typeof import('@headless-tree/react')>();
  return {
    ...m,
    useTree: (config: Parameters<typeof m.useTree>[0]) => {
      const t = m.useTree(config);
      hoisted.tree = t;
      return t;
    },
  };
});
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

const tree = () => hoisted.tree as TreeInstance<FileEntry>;
const listed = (p: string) =>
  vi.mocked(coApi.fs.listDir).mock.calls.filter((c) => c[0] === p).length;
const ids = () => tree().getItems().map((i) => i.getId());
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 250)));

async function mountLoaded(expanded: string[] = []) {
  useExplorerStore.setState({ expandedPaths: new Set(expanded) });
  const r = render(<FolderTree root="/work" />);
  await waitFor(() => expect(hoisted.cb).not.toBeNull());
  for (const p of ['/work', ...expanded]) await waitFor(() => expect(listed(p)).toBeGreaterThan(0));
  await settle();
  const base = new Map(['/work', ...expanded].map((p) => [p, listed(p)]));
  const rebuild = vi.spyOn(tree(), 'rebuildTree');
  return { ...r, rebuild, delta: (p: string) => listed(p) - (base.get(p) ?? 0) };
}

// 手动控制下一次 listDir(p) 的返回时机
function deferNextList(p: string) {
  let resolve!: (entries: FileEntry[]) => void;
  const gate = new Promise<FileEntry[]>((r) => (resolve = r));
  vi.mocked(coApi.fs.listDir).mockImplementationOnce(async (path: string) => {
    expect(path).toBe(p);
    return { ok: true, data: await gate } as never;
  });
  return (entries: FileEntry[]) => act(async () => resolve(entries));
}

beforeEach(() => {
  resetFs();
  hoisted.cb = null;
  hoisted.tree = null;
  vi.mocked(coApi.fs.listDir).mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
});
afterEach(() => cleanup());

describe('FolderTree · 目录内容不变的刷新不 rebuild', () => {
  it('dir-changed 但子项不变 → listDir 一次,不 rebuild', async () => {
    const { rebuild, delta } = await mountLoaded();
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(1));
    await settle();
    expect(rebuild).not.toHaveBeenCalled();
    expect(ids()).toEqual(['/work/a', '/work/a.md']);
  });

  it('只有 size / mtime 变化(原子保存覆盖内容)→ 不 rebuild', async () => {
    const { rebuild, delta } = await mountLoaded();
    fsTree.set('/work', [
      { path: '/work/a', name: 'a', isDirectory: true },
      { path: '/work/a.md', name: 'a.md', isDirectory: false, size: 99, mtime: 99 },
    ]);
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(1));
    await settle();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('外部原子保存:tmp 出现与 rename 落在同一 debounce 窗口,最终列表不变 → 不 rebuild', async () => {
    const { rebuild, delta } = await mountLoaded();
    act(() => {
      hoisted.cb!('/work'); // tmp 出现
      hoisted.cb!('/work'); // tmp rename 覆盖 a.md
    });
    await waitFor(() => expect(delta('/work')).toBe(1));
    await settle();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('外部原子保存:比较时 tmp 仍可见 → 刷新;rename 后再次刷新,tmp 消失', async () => {
    const { rebuild, delta } = await mountLoaded();
    const original = fsTree.get('/work')!;
    fsTree.set('/work', [...original, { path: '/work/.a.md.swp', name: '.a.md.swp', isDirectory: false }]);
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(1));
    await settle();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(ids()).toContain('/work/.a.md.swp');

    fsTree.set('/work', original);
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(2));
    await settle();
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual(['/work/a', '/work/a.md']);
  });
});

describe('FolderTree · 子项变化照常刷新(复用本次 listDir,不二次 IO)', () => {
  const cases: Array<[string, FileEntry[], string[]]> = [
    [
      '新增',
      [
        { path: '/work/a', name: 'a', isDirectory: true },
        { path: '/work/a.md', name: 'a.md', isDirectory: false },
        { path: '/work/b.md', name: 'b.md', isDirectory: false },
      ],
      ['/work/a', '/work/a.md', '/work/b.md'],
    ],
    ['删除', [{ path: '/work/a', name: 'a', isDirectory: true }], ['/work/a']],
    [
      '改名',
      [
        { path: '/work/a', name: 'a', isDirectory: true },
        { path: '/work/c.md', name: 'c.md', isDirectory: false },
      ],
      ['/work/a', '/work/c.md'],
    ],
  ];
  for (const [label, next, expected] of cases) {
    it(`${label} → rebuild 且树反映新列表`, async () => {
      const { rebuild, delta } = await mountLoaded();
      fsTree.set('/work', next);
      act(() => hoisted.cb!('/work'));
      await waitFor(() => expect(ids()).toEqual(expected));
      await settle();
      expect(delta('/work')).toBe(1);
      expect(rebuild).toHaveBeenCalledTimes(1);
    });
  }

  it('类型变化(文件 → 目录)→ 刷新,行变为目录', async () => {
    const { rebuild, delta } = await mountLoaded();
    fsTree.set('/work', [
      { path: '/work/a', name: 'a', isDirectory: true },
      { path: '/work/a.md', name: 'a.md', isDirectory: true },
    ]);
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(tree().getItemInstance('/work/a.md').isFolder()).toBe(true));
    await settle();
    expect(delta('/work')).toBe(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('符号链接标记变化 → 刷新', async () => {
    const { rebuild } = await mountLoaded();
    fsTree.set('/work', [
      { path: '/work/a', name: 'a', isDirectory: true },
      { path: '/work/a.md', name: 'a.md', isDirectory: false, isSymlink: true },
    ]);
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(tree().getItemInstance('/work/a.md').getItemData().isSymlink).toBe(true));
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('listDir 失败 → 走原刷新路径(重新加载,失败按原语义清空)', async () => {
    const { delta } = await mountLoaded();
    vi.mocked(coApi.fs.listDir).mockResolvedValueOnce({ ok: false, code: 'FS_EACCES', message: 'x' } as never);
    vi.mocked(coApi.fs.listDir).mockResolvedValueOnce({ ok: false, code: 'FS_EACCES', message: 'x' } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(2));
    await waitFor(() => expect(ids()).toEqual([]));
    warn.mockRestore();
  });
});

describe('FolderTree · 比较期间的并发', () => {
  it('同目录并发刷新:迟到的旧结果不覆盖后发起的新结果', async () => {
    const { delta } = await mountLoaded();
    const resolveFirst = deferNextList('/work');
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(1));
    const latest = [
      { path: '/work/a', name: 'a', isDirectory: true },
      { path: '/work/new.md', name: 'new.md', isDirectory: false },
    ];
    fsTree.set('/work', latest);
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(2));
    await waitFor(() => expect(ids()).toEqual(['/work/a', '/work/new.md']));
    await resolveFirst([{ path: '/work/stale.md', name: 'stale.md', isDirectory: false }]);
    await settle();
    expect(ids()).toEqual(['/work/a', '/work/new.md']);
  });

  it('比较期间折叠该目录 → 缓存照样更新,重新展开直接显示新子项(不再 listDir)', async () => {
    const { delta } = await mountLoaded(['/work/a']);
    const resolve = deferNextList('/work/a');
    act(() => hoisted.cb!('/work/a'));
    await waitFor(() => expect(delta('/work/a')).toBe(1));
    act(() => useExplorerStore.setState({ expandedPaths: new Set() }));
    await settle();
    await resolve([
      { path: '/work/a/x.ts', name: 'x.ts', isDirectory: false },
      { path: '/work/a/y.ts', name: 'y.ts', isDirectory: false },
    ]);
    act(() => useExplorerStore.setState({ expandedPaths: new Set(['/work/a']) }));
    await waitFor(() => expect(ids()).toContain('/work/a/y.ts'));
    await settle();
    expect(delta('/work/a')).toBe(1);
  });

  it('比较期间卸载 → 结果丢弃,不 rebuild', async () => {
    const { rebuild, unmount, delta } = await mountLoaded();
    const resolve = deferNextList('/work');
    act(() => hoisted.cb!('/work'));
    await waitFor(() => expect(delta('/work')).toBe(1));
    unmount();
    rebuild.mockClear();
    await resolve([{ path: '/work/z.md', name: 'z.md', isDirectory: false }]);
    await settle();
    expect(rebuild).not.toHaveBeenCalled();
  });
});
