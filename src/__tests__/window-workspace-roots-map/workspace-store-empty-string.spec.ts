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
    activePath: null,
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
    search: '',
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
});
