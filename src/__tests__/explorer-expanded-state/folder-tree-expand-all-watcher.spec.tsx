// @vitest-environment jsdom
// 「全部展开」批量期 watcher 同步:store 批末才写,但 fs watcher 必须跟随树实际展开集合
// 在批次进行中就装上(Linux watcher 非递归,批中目录变化若无 watcher 会永久漏掉)。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

// /work 下 a、b 两个子目录;a 下有 a1。/work/b 的 listDir 被挂起直到测试放行。
const fsTree = new Map<string, FileEntry[]>([
  [
    '/work',
    [
      { path: '/work/a', name: 'a', isDirectory: true },
      { path: '/work/b', name: 'b', isDirectory: true },
    ],
  ],
  ['/work/a', [{ path: '/work/a/a1', name: 'a1', isDirectory: true }]],
  ['/work/a/a1', []],
  ['/work/b', []],
]);
const gate = vi.hoisted(() => ({ release: null as null | (() => void) }));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => {
        if (p === '/work/b' && gate.release === null) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return { ok: true, data: fsTree.get(p) ?? [] };
      }),
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

const headerProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({
  ExplorerHeader: (props: Record<string, unknown>) => {
    headerProps.current = props;
    return null;
  },
}));

import { coApi } from '@/lib/co-api';
import { FolderTree } from '../../panels/Explorer/FolderTree';

beforeEach(() => {
  gate.release = null;
  vi.mocked(coApi.fs.watchDir).mockClear();
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
});

afterEach(() => {
  gate.release?.();
  cleanup();
});

const watched = () => vi.mocked(coApi.fs.watchDir).mock.calls.map((c) => c[0]);

describe('FolderTree · 全部展开批量期 watcher 跟随树实际展开集合', () => {
  it('批次未结束(store 未写)时,已展开目录的 watcher 已安装', async () => {
    render(<FolderTree root="/work" />);
    await waitFor(() => expect(headerProps.current).not.toBeNull());
    await act(async () => {
      (headerProps.current!.onExpandAll as () => void)();
    });
    // /work/b 的 listDir 挂起 → 批次仍在进行
    await waitFor(() => expect(gate.release).not.toBeNull());
    await waitFor(() =>
      expect(watched()).toEqual(expect.arrayContaining(['/work/a', '/work/a/a1'])),
    );
    // store 仍未写入(批量回写语义不变)
    expect(useExplorerStore.getState().expandedPaths.has('/work/a')).toBe(false);

    await act(async () => {
      gate.release!();
    });
    await waitFor(() =>
      expect(useExplorerStore.getState().expandedPaths.has('/work/b')).toBe(true),
    );
    expect(watched()).toEqual(expect.arrayContaining(['/work/b']));
  });
});
