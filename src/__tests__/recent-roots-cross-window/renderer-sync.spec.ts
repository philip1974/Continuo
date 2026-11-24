// @vitest-environment jsdom
// 「最近打开」多窗口同步:renderer 侧 setRoot → touch、广播 → 更新 store。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useExplorerStore } from '../../stores/explorer.store';
import { usePinnedStore } from '../../stores/pinned.store';
import { useEditorStore } from '../../stores/editor.store';
import { workspaceRootSelectionGuard } from '../../lib/workspace-root-guard';
import {
  forgetRecentRoot,
  initExplorerPersistence,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';

beforeEach(() => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  usePinnedStore.setState({ paths: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
});

function snap(recentRoots: string[]): ExplorerSnapshot {
  return {
    version: 3,
    workspace: { recentRoots },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [
      {
        windowSeq: 0,
        workspace: { root: recentRoots[0] ?? null },
        explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
      },
    ],
  };
}

function makeApi(read: ExplorerPersistApi['read']) {
  let listener: ((list: string[]) => void) | null = null;
  const api = {
    read,
    write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    touchRecent: vi.fn(async (_path: string) => ({ ok: true as const, data: undefined })),
    removeRecent: vi.fn(async (_path: string) => ({ ok: true as const, data: undefined })),
    onRecentChanged: vi.fn((cb: (list: string[]) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  } satisfies ExplorerPersistApi;
  return { api, emit: (list: string[]) => listener?.(list) };
}

describe('recentRoots 跨窗口同步 · renderer', () => {
  it('setRoot 置顶新 root → 立即 touchRecent(root)', async () => {
    const { api } = makeApi(async () => ({ ok: true, data: snap(['/a']) }));
    await initExplorerPersistence(api);
    expect(api.touchRecent).not.toHaveBeenCalled(); // hydrate 不发

    useWorkspaceStore.getState().setRoot('/x');
    expect(api.touchRecent).toHaveBeenCalledTimes(1);
    expect(api.touchRecent).toHaveBeenCalledWith('/x');

    useWorkspaceStore.getState().setRoot('/x'); // 已在头部 → 不重复发
    expect(api.touchRecent).toHaveBeenCalledTimes(1);
  });

  it('收到广播 → 本窗 store 更新为 main 列表,且不回发 touch', async () => {
    const { api, emit } = makeApi(async () => ({ ok: true, data: snap(['/a']) }));
    await initExplorerPersistence(api);

    emit(['/x', '/a']);

    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/x', '/a']);
    expect(useWorkspaceStore.getState().root).toBe('/a'); // root 不受影响
    expect(api.touchRecent).not.toHaveBeenCalled();
  });

  it('读盘期间用户已选 root(R38)→ hydrate 后补发 touch,最新的最后发', async () => {
    let resolveRead: (r: { ok: true; data: ExplorerSnapshot }) => void = () => {};
    const { api } = makeApi(
      () =>
        new Promise((res) => {
          resolveRead = res;
        }),
    );
    const init = initExplorerPersistence(api);
    workspaceRootSelectionGuard.begin(); // UI 入口选 root 前都会 begin()
    useWorkspaceStore.getState().setRoot('/p1');
    useWorkspaceStore.getState().setRoot('/p2');
    resolveRead({ ok: true, data: snap(['/old']) });
    await init;

    expect(api.touchRecent.mock.calls.map((c) => c[0])).toEqual(['/p1', '/p2']);
  });
});

describe('recentRoots 移除 · renderer', () => {
  it('forgetRecentRoot → 发 removeRecent(main 锁内移除并广播),本窗列表立即去掉该项;移除头部也不发 touch', async () => {
    const { api } = makeApi(async () => ({ ok: true, data: snap(['/a', '/b', '/c']) }));
    await initExplorerPersistence(api);
    useWorkspaceStore.setState({ recentRoots: ['/a', '/b', '/c'] });

    forgetRecentRoot('/a');

    expect(api.removeRecent).toHaveBeenCalledWith('/a');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/b', '/c']);
    expect(api.touchRecent).not.toHaveBeenCalled();
  });
});
