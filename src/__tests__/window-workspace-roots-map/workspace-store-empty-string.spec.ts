import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeWorkspaceRoot,
  useWorkspaceStore,
} from '../../stores/workspace.store';
import { useExplorerStore } from '../../stores/explorer.store';
import { usePinnedStore } from '../../stores/pinned.store';
import {
  SIDEBAR_DEFAULT_WIDTH,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
import { useEditorStore } from '../../stores/editor.store';
import {
  hydrateStores,
  initExplorerPersistence,
  snapshotFromStores,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';
import {
  PATH_STR_MAX,
  ExplorerWritableSnapshotSchema,
} from '../../../electron/shared/explorer-persistence-schema';

const baseSnapshot = (root: string | null = '/work'): ExplorerSnapshot => ({
  version: 3,
  workspace: { recentRoots: ['/a', '/b'] },
  pinned: { paths: [] },
  nextWindowSeq: 2,
  windows: [
    {
      windowSeq: 0,
      workspace: { root },
      explorer: {
        activePath: null,
        expandedPaths: [],
        sort: { by: 'name', reverse: false },
      },
    },
  ],
});

function resetStores(): void {
  useWorkspaceStore.setState({
    root: null,
    recentRoots: [],
    hydrated: false,
  });
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
  usePinnedStore.setState({ paths: [] });
  useLayoutUiStore.setState({
    sidebarOpen: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
  useEditorStore.setState({ tabs: [], activeTabId: null });
}

beforeEach(() => {
  resetStores();
});

describe('window-workspace-roots-map: workspace root normalization', () => {
  it("T27: normalizeWorkspaceRoot('') returns null", () => {
    expect(normalizeWorkspaceRoot('')).toBeNull();
  });

  it("T28: normalizeWorkspaceRoot('   ') returns null", () => {
    expect(normalizeWorkspaceRoot('   ')).toBeNull();
  });

  it("T28b: normalizeWorkspaceRoot('  /abs  ') preserves whitespace", () => {
    expect(normalizeWorkspaceRoot('  /abs  ')).toBe('  /abs  ');
  });

  it("T29: normalizeWorkspaceRoot('/abs') returns the path", () => {
    expect(normalizeWorkspaceRoot('/abs')).toBe('/abs');
  });

  it('T30: hydrateStores normalizes empty workspace root to null', () => {
    hydrateStores(baseSnapshot(''));

    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it('T31: hydrateStores filters empty recentRoots', () => {
    hydrateStores({
      ...baseSnapshot('/work'),
      workspace: { recentRoots: ['/a', '', '/b'] },
    });

    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/a', '/b']);
  });

  it('T32: hydrateStoresForNewWindow normalizes empty initialWorkspace through initExplorerPersistence', async () => {
    const api: ExplorerPersistApi = {
      read: vi.fn(async () => ({ ok: true as const, data: null })),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };

    await initExplorerPersistence(api, {
      windowSeq: 1,
      initialWorkspace: '',
    });

    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it('T33: snapshotFromStores defensively normalizes empty store root', () => {
    useWorkspaceStore.setState({
      root: '',
      recentRoots: ['/a', '', '/b'],
    });

    const snap = snapshotFromStores();

    expect(snap.windows[0]!.workspace.root).toBeNull();
    expect(snap.workspace.recentRoots).toEqual(['/a', '/b']);
  });

  // 边界(E137,E8 同族;query 解析处已守卫,此处对导出 API 防御性兜底):unsafe integer windowSeq
  // 会让 windowSeq+1 因精度 no-op/碰撞污染 nextWindowSeq 与段索引。非法 → 回退主窗位(0)。
  it('E137: snapshotFromStores 对 unsafe integer windowSeq 回退主窗位,不污染 nextWindowSeq', () => {
    useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
    const unsafe = Number.MAX_SAFE_INTEGER + 2; // 9007199254740993 → 舍入,+1 no-op
    const snap = snapshotFromStores(undefined, unsafe);
    // 段 windowSeq 回退 0(主窗位),不写入 unsafe 值
    expect(snap.windows[0]!.windowSeq).toBe(0);
    // nextWindowSeq 是安全整数(回退后 0+1=1),非被精度碰撞污染的 unsafe 值
    expect(Number.isSafeInteger(snap.nextWindowSeq)).toBe(true);
    expect(snap.nextWindowSeq).toBe(1);
  });

  it('E137: 合法 windowSeq 正常写入段与 nextWindowSeq', () => {
    useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
    const snap = snapshotFromStores(undefined, 5);
    expect(snap.windows[0]!.windowSeq).toBe(5);
    expect(snap.nextWindowSeq).toBe(6);
  });

  // 边界(E317,E276/E277/E278 同族):root/recentRoots 超 PATH_STR_MAX → null/过滤,
  // 防 snapshotFromStores 写出后 ExplorerWritableSnapshotSchema 拒整份 → explorer 持久化全失败。
  it('E317: normalizeWorkspaceRoot 超 PATH_STR_MAX 的 root → null', () => {
    const longPath = '/' + 'x'.repeat(PATH_STR_MAX);
    expect(longPath.length).toBeGreaterThan(PATH_STR_MAX);
    expect(normalizeWorkspaceRoot(longPath)).toBeNull();
  });

  it('E317: 恰好 PATH_STR_MAX 长度的 root 仍保留(边界含等于)', () => {
    const maxPath = 'x'.repeat(PATH_STR_MAX);
    expect(maxPath.length).toBe(PATH_STR_MAX);
    expect(normalizeWorkspaceRoot(maxPath)).toBe(maxPath);
  });

  it('E317: setRoot 超长 root → root=null(不污染 store)', () => {
    const longPath = '/' + 'x'.repeat(PATH_STR_MAX);
    useWorkspaceStore.getState().setRoot(longPath);
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it('E317: snapshotFromStores 把超长 root/recentRoot 清成 schema-合法快照', () => {
    const longPath = '/' + 'x'.repeat(PATH_STR_MAX);
    useWorkspaceStore.setState({
      root: longPath,
      recentRoots: ['/a', longPath, '/b'],
    });

    const snap = snapshotFromStores();

    expect(snap.windows[0]!.workspace.root).toBeNull();
    expect(snap.workspace.recentRoots).toEqual(['/a', '/b']);
    // 关键:整份快照通过持久化 schema(否则 explorer:write 拒整份 → 全失败)
    expect(ExplorerWritableSnapshotSchema.safeParse(snap).success).toBe(true);
  });
});
