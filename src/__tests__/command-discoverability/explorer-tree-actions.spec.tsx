// @vitest-environment jsdom
// BDD: command-discoverability —— 「在资源管理器中折叠文件夹」「刷新资源管理器」命令作用在文件树上(同标题栏「全部折叠」
// 「刷新」按钮)。见同目录 README 第 2 条。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const fsTree = new Map<string, FileEntry[]>();

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async (p: string) => ({ ok: true, data: fsTree.get(p) ?? [] })),
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
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 28,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
  }),
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
import { __resetExplorerRequestsForTest } from '../../panels/Explorer/explorer-requests';
import { ExplorerSidebar } from '../../shell/ExplorerSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { explorerCommandSpecs } from '../../panels/Explorer/explorer-commands';

const run = async (id: string): Promise<void> => {
  const spec = explorerCommandSpecs().find((c) => c.id === id);
  if (!spec) throw new Error(`no command ${id}`);
  await act(async () => {
    await spec.fn();
  });
};
const row = (p: string) => document.querySelector<HTMLElement>(`[title="${p}"]`);

beforeEach(() => {
  fsTree.clear();
  fsTree.set('/work', [
    { path: '/work/alpha', name: 'alpha', isDirectory: true },
    { path: '/work/beta.ts', name: 'beta.ts', isDirectory: false },
  ]);
  fsTree.set('/work/alpha', [{ path: '/work/alpha/inner.ts', name: 'inner.ts', isDirectory: false }]);
  __resetExplorerRequestsForTest();
  vi.mocked(coApi.fs.listDir).mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useLayoutUiStore.setState({ sidebarOpen: true });
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
});
afterEach(() => {
  cleanup();
});

describe('资源管理器标题栏动作的命令', () => {
  it('折叠 → 已展开的文件夹全部收起', async () => {
    render(<ExplorerSidebar />);
    await waitFor(() => expect(row('/work/alpha')).not.toBeNull());
    act(() => {
      fireEvent.click(row('/work/alpha')!);
    });
    await waitFor(() => expect(row('/work/alpha/inner.ts')).not.toBeNull());
    await run('workbench.files.action.collapseExplorerFolders');
    await waitFor(() => expect(row('/work/alpha/inner.ts')).toBeNull());
  });

  it('刷新 → 重新读取根目录,外部新增的文件出现', async () => {
    render(<ExplorerSidebar />);
    await waitFor(() => expect(row('/work/beta.ts')).not.toBeNull());
    fsTree.set('/work', [...fsTree.get('/work')!, { path: '/work/gamma.ts', name: 'gamma.ts', isDirectory: false }]);
    await run('workbench.files.action.refreshFilesExplorer');
    await waitFor(() => expect(row('/work/gamma.ts')).not.toBeNull());
  });
});
