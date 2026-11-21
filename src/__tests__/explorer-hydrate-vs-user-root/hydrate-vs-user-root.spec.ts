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
  flushExplorerPersistence,
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
    // 也不应把旧 snapshot 的窗口段(expanded/layout/editor)灌进来。
    expect(useExplorerStore.getState().expandedPaths.has('/old')).toBe(false);
  });

  it('read 期间用户选了新 workspace → 快照里无关的全局段(pinned/recentRoots)仍保留,不被默认值覆盖写盘', async () => {
    let resolveRead: (r: { ok: true; data: ExplorerSnapshot }) => void = () => {};
    const write = vi.fn(async (_snap: ExplorerSnapshot) => ({ ok: true as const, data: undefined }));
    const api: ExplorerPersistApi = {
      read: vi.fn(
        () =>
          new Promise<{ ok: true; data: ExplorerSnapshot }>((res) => {
            resolveRead = res;
          }),
      ),
      write,
    };
    const p = initExplorerPersistence(api, { windowSeq: 0 });
    workspaceRootSelectionGuard.begin();
    useWorkspaceStore.getState().setRoot('/userPicked');

    const snap: ExplorerSnapshot = {
      ...snapWithRoot('/old'),
      workspace: { recentRoots: ['/old', '/older'] },
      pinned: { paths: ['/old/a.ts', '/b.ts'] },
    };
    resolveRead({ ok: true, data: snap });
    await p;

    expect(useWorkspaceStore.getState().root).toBe('/userPicked');
    // 用户选择排最前,快照中的历史 recent 保留在后
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/userPicked', '/old', '/older']);
    expect(usePinnedStore.getState().paths).toEqual(['/old/a.ts', '/b.ts']);

    // 随后的写盘携带的全局段 = 合并后的值(main 合并以 writable 顶层为准,默认值会覆盖磁盘)
    await flushExplorerPersistence();
    const written = write.mock.calls.at(-1)?.[0];
    expect(written?.workspace.recentRoots).toEqual(['/userPicked', '/old', '/older']);
    expect(written?.pinned.paths).toEqual(['/old/a.ts', '/b.ts']);
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
