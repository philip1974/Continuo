// @vitest-environment jsdom
// race(R38):initExplorerPersistence 是 fire-and-forget,UI 在 `await api.read()` 完成前就以
// root=null 渲染、可交互。冷启动磁盘/IPC 慢时用户经 EmptyWorkspace/drop/recent 选了新 workspace,
// 迟到的 hydrate 不得用旧 snapshot 覆盖用户选择(否则 root/recent/pinned/layout 回退 + 持久化错误
// workspace)。复用 workspaceRootSelectionGuard(R27):read 期间有用户 root 选择 → 跳过迟到 hydrate。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useExplorerStore } from '../../stores/explorer.store';
import { usePinnedStore } from '../../stores/pinned.store';
import { useEditorStore } from '../../stores/editor.store';
import { workspaceRootSelectionGuard } from '../../lib/workspace-root-guard';
import {
  initExplorerPersistence,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';

beforeEach(() => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
  usePinnedStore.setState({ paths: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
});

function snapWithRoot(root: string): ExplorerSnapshot {
  return {
    version: 3,
    workspace: { recentRoots: [root] },
    pinned: { paths: [] },
    nextWindowSeq: 2,
    windows: [
      {
        windowSeq: 0,
        workspace: { root },
        explorer: {
          activePath: null,
          expandedPaths: [root],
          sort: { by: 'name', reverse: false },
        },
        layoutUi: { sidebarOpen: true, sidebarWidth: 320 },
      },
    ],
  };
}

describe('race(R38) · hydrate 不覆盖 read 期间的用户 root 选择', () => {
  it('read await 期间用户选了新 workspace → 迟到 hydrate 跳过,不覆盖用户 root', async () => {
    let resolveRead: (r: { ok: true; data: ExplorerSnapshot }) => void = () => {};
    const api: ExplorerPersistApi = {
      read: vi.fn(
        () =>
          new Promise<{ ok: true; data: ExplorerSnapshot }>((res) => {
            resolveRead = res;
          }),
      ),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };

    const p = initExplorerPersistence(api, { windowSeq: 0 }); // begin() 捕获启动恢复代际

    // 用户在 read 在途时经 EmptyWorkspace/drop/recent 选了新 workspace:守卫 begin() + setRoot。
    workspaceRootSelectionGuard.begin();
    useWorkspaceStore.setState({ root: '/userPicked' });

    // 旧 explorer.json 读取完成(root='/old')→ 迟到 hydrate 应跳过。
    resolveRead({ ok: true, data: snapWithRoot('/old') });
    await p;

    expect(useWorkspaceStore.getState().root).toBe('/userPicked'); // 未被 '/old' 覆盖
    // 也不应把旧 snapshot 的 expanded/recent 灌进来(整段 hydrate 跳过)。
    expect(useExplorerStore.getState().expandedPaths.has('/old')).toBe(false);
  });

  it('控制组:read 期间无用户选择 → 正常 hydrate 旧 snapshot root', async () => {
    const api: ExplorerPersistApi = {
      read: vi.fn(async () => ({ ok: true as const, data: snapWithRoot('/old') })),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };
    await initExplorerPersistence(api, { windowSeq: 0 });
    expect(useWorkspaceStore.getState().root).toBe('/old');
  });
});
