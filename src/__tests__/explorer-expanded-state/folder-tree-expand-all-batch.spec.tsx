// @vitest-environment jsdom
// 「全部展开」批量回写:真 headless-tree(useTree 不 mock)逐目录 expand,
// 期间 store.expandedPaths 只在批次末尾写一次,最终展开集合与逐步回写一致。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

// root /work 下 3 层目录树:每个目录 3 个子目录 + 1 个文件(深度 3 → 3+9+27=39 个目录)。
function buildFs(): Map<string, FileEntry[]> {
  const fs = new Map<string, FileEntry[]>();
  const fill = (dir: string, depth: number) => {
    const entries: FileEntry[] = [];
    if (depth < 3) {
      for (const n of ['a', 'b', 'c']) {
        const p = `${dir}/${n}`;
        entries.push({ path: p, name: n, isDirectory: true });
        fill(p, depth + 1);
      }
    }
    entries.push({ path: `${dir}/f.txt`, name: 'f.txt', isDirectory: false });
    fs.set(dir, entries);
  };
  fill('/work', 0);
  return fs;
}

const fsTree = buildFs();
const ALL_DIRS = [...fsTree.keys()];

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
      onDirChanged: vi.fn(() => vi.fn()),
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

// 捕获 Header 的 onExpandAll / onCollapseAll,直接驱动(Header 自身 UI 由 explorer-header 规范覆盖)。
const headerProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({
  ExplorerHeader: (props: Record<string, unknown>) => {
    headerProps.current = props;
    return null;
  },
}));

import { FolderTree } from '../../panels/Explorer/FolderTree';

beforeEach(() => {
  useExplorerStore.setState({
    expandedPaths: new Set(['/elsewhere/x']),
    sort: { by: 'name', reverse: false },
  });
});

afterEach(() => {
  cleanup();
});

describe('FolderTree · 全部展开批量回写 store', () => {
  it('逐目录展开期间不逐步写 store,批末一次写入全部目录(保留 out-of-root)', async () => {
    render(<FolderTree root="/work" />);
    // 等根 children 加载完
    await waitFor(() => expect(headerProps.current).not.toBeNull());

    let writes = 0;
    const unsub = useExplorerStore.subscribe((s, prev) => {
      if (s.expandedPaths !== prev.expandedPaths) writes += 1;
    });
    try {
      await act(async () => {
        (headerProps.current!.onExpandAll as () => void)();
      });
      await waitFor(() => {
        const set = useExplorerStore.getState().expandedPaths;
        for (const d of ALL_DIRS) expect(set.has(d)).toBe(true);
      });
      // 39 个目录:逐步回写会写 ~39 次;批量后只在末尾写 1 次。
      expect(writes).toBe(1);
      const set = useExplorerStore.getState().expandedPaths;
      expect(set.has('/elsewhere/x')).toBe(true);
      expect(set.size).toBe(ALL_DIRS.length + 1);
    } finally {
      unsub();
    }
  });

  it('批量结束后普通展开/折叠仍逐次回写 store', async () => {
    render(<FolderTree root="/work" />);
    await waitFor(() => expect(headerProps.current).not.toBeNull());
    await act(async () => {
      (headerProps.current!.onExpandAll as () => void)();
    });
    await waitFor(() =>
      expect(useExplorerStore.getState().expandedPaths.has('/work/c/c/c')).toBe(true),
    );
    await act(async () => {
      (headerProps.current!.onCollapseAll as () => void)();
    });
    expect([...useExplorerStore.getState().expandedPaths]).toEqual(['/elsewhere/x']);
  });
});
