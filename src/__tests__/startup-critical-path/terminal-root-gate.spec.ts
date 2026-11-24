// @vitest-environment jsdom
// 性能(冷启动关键路径):首个用户终端只需 workspace root,不等编辑器 tab 恢复读盘。
// rootRestored 在 root 恢复后、hydrateEditorTabs(最多 256 tab、并发 32 读盘)之前置位;createUserTerminal 等它。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { create: mocks.create } },
}));
vi.mock('@/lib/terminal-chunk-warmup', () => ({
  preloadTerminalPanelChunk: vi.fn(),
}));
vi.mock('@/shell/dock/DockReconciler', () => ({
  setPendingFocus: vi.fn(),
}));

import {
  useWorkspaceStore,
  waitForWorkspaceRootRestored,
} from '@/stores/workspace.store';
import { useEditorStore } from '@/stores/editor.store';
import {
  initExplorerPersistence,
  type EditorSessionFsApi,
  type ExplorerSnapshot,
} from '@/lib/persist/explorer-persist';
import { createUserTerminal } from '@/shell/dock/create-user-terminal';

function snap(): ExplorerSnapshot {
  return {
    version: 2,
    workspace: { recentRoots: ['/w'] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [
      {
        windowSeq: 0,
        workspace: { root: '/w' },
        explorer: {
          activePath: null,
          expandedPaths: [],
          sort: { by: 'name', reverse: false },
        },
        editor: { openFilePaths: ['/w/a.md'], activePath: '/w/a.md' },
      },
    ],
  };
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.create.mockResolvedValue({ ok: true, data: { id: 'term-1' } });
  useWorkspaceStore.setState({
    root: null,
    recentRoots: [],
    rootRestored: false,
  });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

describe('waitForWorkspaceRootRestored', () => {
  it('rootRestored 为 false 时挂起;markRootRestored 后 resolve', async () => {
    let done = false;
    const p = waitForWorkspaceRootRestored().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    useWorkspaceStore.getState().markRootRestored();
    await p;
    expect(done).toBe(true);
  });

  it('已 rootRestored 时立即 resolve', async () => {
    useWorkspaceStore.setState({ rootRestored: true });
    await expect(waitForWorkspaceRootRestored()).resolves.toBeUndefined();
  });
});

describe('createUserTerminal 不等编辑器 tab 读盘', () => {
  it('tab 读盘在途时已用恢复出的 root 发起 terminal.create', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fs: EditorSessionFsApi = {
      readFile: vi.fn(async () => {
        await gate;
        return { ok: true as const, data: 'hello' };
      }),
    };
    const persistDone = initExplorerPersistence(
      {
        read: vi.fn(async () => ({ ok: true as const, data: snap() })),
        write: vi.fn(async () => ({ ok: true as const, data: undefined })),
      },
      { fs },
    );
    await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalled());

    const id = await createUserTerminal();

    expect(id).toBe('term-1');
    expect(mocks.create).toHaveBeenCalledWith({
      originHint: 'user',
      cwd: '/w',
      workspaceRoot: '/w',
      env: { COLORFGBG: '0;15' },
    });

    release();
    await persistDone;
  });

  it('root 尚未恢复时仍等待(不以初始 null root 创建)', async () => {
    let done = false;
    const p = createUserTerminal().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(done).toBe(false);

    useWorkspaceStore.getState().setRoot('/repo');
    useWorkspaceStore.getState().markRootRestored();
    await p;
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', workspaceRoot: '/repo' }),
    );
  });
});
