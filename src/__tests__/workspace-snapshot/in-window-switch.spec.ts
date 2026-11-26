// @vitest-environment jsdom
// BDD: workspace-snapshot / 同一窗口切换 root(⌘O / 最近打开 / 拖入文件夹):切换前把当前文件夹的状态送 main 存为快照,
// 切到的文件夹有快照则恢复编辑器 tab / 展开 / 侧栏 / 搜索输入;没有则保持原有行为。复现 b:ws2 开着 w2.ts → 切到 ws3 → 切回 ws2,
// w2.ts 回来。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: { search: { start: vi.fn(async () => ({ ok: true })), cancel: vi.fn(async () => ({ ok: true })), onEvent: () => () => {} } },
}));
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: vi.fn() } } }));

import { setBeforeWorkspaceRootSwitch, useWorkspaceStore } from '@/stores/workspace.store';
import { useEditorStore } from '@/stores/editor.store';
import { useExplorerStore } from '@/stores/explorer.store';
import { SIDEBAR_DEFAULT_WIDTH, useLayoutUiStore } from '@/stores/layout-ui.store';
import { __resetSearchForTest, useSearchStore } from '@/panels/Search/search-store';
import { clearEditorViewStates } from '@/panels/Editor/editor-view-state-cache';
import {
  initExplorerPersistence,
  type EditorSessionFsApi,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '@/lib/persist/explorer-persist';
import type { WorkspaceSnapshotState } from '../../../electron/shared/explorer-persistence-schema';
import { flushMicrotasks } from '../_helpers/async';

const SORT = { by: 'name', reverse: false } as const;
const W2 = '/ws2/w2.ts';

const FILES: Record<string, string> = { [W2]: 'two\n', '/ws2/other.ts': 'o\n', '/ws3/b.ts': 'b\n' };
const fs: EditorSessionFsApi = {
  readFile: vi.fn(async (p: string) =>
    FILES[p] === undefined ? { ok: false as const, code: 'FS_ENOENT', message: 'nf' } : { ok: true as const, data: FILES[p]! },
  ),
};

function startSnap(): ExplorerSnapshot {
  return {
    version: 3,
    workspace: { recentRoots: ['/ws2'] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [
      {
        windowSeq: 0,
        workspace: { root: '/ws2' },
        explorer: { activePath: null, expandedPaths: ['/ws2/src'], sort: SORT },
        layoutUi: { sidebarOpen: false, sidebarWidth: 300 },
        editor: { openFilePaths: [W2], activePath: W2 },
        search: { pattern: 'todo' },
      },
    ],
  };
}

type SwitchInput = Parameters<NonNullable<ExplorerPersistApi['switchWorkspace']>>[0];
type SwitchReply = { ok: true; data: SwitchInput['save'] | WorkspaceSnapshotState | null };
let switchWorkspace: ReturnType<typeof vi.fn<(input: SwitchInput) => Promise<SwitchReply>>>;
let onRestored: ReturnType<typeof vi.fn>;

async function init(): Promise<void> {
  const api: ExplorerPersistApi = {
    read: async () => ({ ok: true, data: startSnap() }),
    write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    switchWorkspace,
  };
  await initExplorerPersistence(api, { fs, windowSeq: 0, onWorkspaceSnapshotRestored: onRestored });
}

const openPaths = (): string[] => useEditorStore.getState().tabs.map((t) => t.filePath);

beforeEach(() => {
  clearEditorViewStates();
  __resetSearchForTest();
  useWorkspaceStore.setState({ root: null, recentRoots: [], rootRestored: false });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    mode: 'source',
  });
  useExplorerStore.setState({ expandedPaths: new Set(), sort: SORT });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
  switchWorkspace = vi.fn(async () => ({ ok: true as const, data: null }));
  onRestored = vi.fn();
});

afterEach(() => setBeforeWorkspaceRootSwitch(null));

describe('切换 root 之前:当前文件夹的状态送 main 存为快照', () => {
  it('在关掉 root 外 tab 之前取状态(tab / 展开 / 侧栏 / 搜索),不带 windowSeq', async () => {
    await init();
    expect(openPaths()).toEqual([W2]);

    useWorkspaceStore.getState().setRoot('/ws3');

    expect(switchWorkspace).toHaveBeenCalledTimes(1);
    const { save, open } = switchWorkspace.mock.calls[0]![0];
    expect(open).toBe('/ws3');
    expect(save).toMatchObject({
      workspace: { root: '/ws2' },
      explorer: { expandedPaths: ['/ws2/src'] },
      layoutUi: { sidebarOpen: false, sidebarWidth: 300 },
      editor: { openFilePaths: [W2], activePath: W2 },
      search: { pattern: 'todo' },
    });
    expect(save).not.toHaveProperty('windowSeq');
  });

  it('切到同一文件夹 → 不发;从空窗口打开文件夹 → 不存(save=null)、只取新文件夹的快照', async () => {
    await init();
    useWorkspaceStore.getState().setRoot('/ws2/');
    expect(switchWorkspace).not.toHaveBeenCalled();

    useWorkspaceStore.getState().setRoot(null);
    useWorkspaceStore.getState().setRoot('/ws3');
    expect(switchWorkspace.mock.calls.map((c) => c[0].open)).toEqual([null, '/ws3']);
    expect(switchWorkspace.mock.calls[1]![0].save).toBeNull();
  });
});

describe('切到有快照的文件夹:恢复', () => {
  it('复现 b:ws2(w2.ts)→ ws3 → 切回 ws2,w2.ts 与侧栏 / 展开 / 搜索输入回来', async () => {
    await init();
    useWorkspaceStore.getState().setRoot('/ws3');
    await flushMicrotasks(5);
    expect(openPaths()).toEqual([]);
    const savedWs2 = switchWorkspace.mock.calls[0]![0].save!;
    switchWorkspace.mockImplementationOnce(async () => ({ ok: true as const, data: savedWs2 }));
    // 切到 ws3 后用户改了侧栏 / 搜索
    useLayoutUiStore.setState({ sidebarOpen: true });
    useSearchStore.setState({ pattern: 'ws3 query' });

    useWorkspaceStore.getState().setRoot('/ws2');

    await vi.waitFor(() => expect(openPaths()).toEqual([W2]));
    expect(useEditorStore.getState().activeTabId).toBe(W2);
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
    expect([...useExplorerStore.getState().expandedPaths]).toEqual(['/ws2/src']);
    expect(useSearchStore.getState().pattern).toBe('todo');
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it('快照里的文件已被删除 → 跳过它,其余照常恢复', async () => {
    await init();
    useWorkspaceStore.getState().setRoot('/ws3');
    await flushMicrotasks(5);
    switchWorkspace.mockImplementationOnce(async () => ({
      ok: true as const,
      data: {
        workspace: { root: '/ws2' },
        explorer: { activePath: null, expandedPaths: [], sort: SORT },
        editor: { openFilePaths: ['/ws2/deleted.ts', '/ws2/other.ts'], activePath: '/ws2/deleted.ts' },
      },
    }));

    useWorkspaceStore.getState().setRoot('/ws2');

    await vi.waitFor(() => expect(openPaths()).toEqual(['/ws2/other.ts']));
  });
});

describe('没有快照 / 回复作废:保持原有行为', () => {
  it('没有快照 → 只关掉 root 外的 tab,侧栏 / 展开不动', async () => {
    await init();
    useWorkspaceStore.getState().setRoot('/ws3');
    await flushMicrotasks(5);
    expect(openPaths()).toEqual([]);
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
    expect([...useExplorerStore.getState().expandedPaths]).toEqual(['/ws2/src']);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('回复到达前又切到别的文件夹 → 迟到的快照不应用', async () => {
    await init();
    let resolveFirst!: (v: SwitchReply) => void;
    switchWorkspace.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    useWorkspaceStore.getState().setRoot('/ws3');
    useWorkspaceStore.getState().setRoot('/ws4');
    resolveFirst({
      ok: true,
      data: {
        workspace: { root: '/ws3' },
        explorer: { activePath: null, expandedPaths: ['/ws3/lib'], sort: SORT },
        editor: { openFilePaths: ['/ws3/b.ts'], activePath: '/ws3/b.ts' },
      },
    });
    await flushMicrotasks(10);
    expect(openPaths()).toEqual([]);
    expect([...useExplorerStore.getState().expandedPaths]).not.toContain('/ws3/lib');
  });
});
