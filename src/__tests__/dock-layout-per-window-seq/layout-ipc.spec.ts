import { beforeEach, describe, expect, it } from 'vitest';

import {
  hydrateStores,
  snapshotFromStores,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';
import { useExplorerStore } from '../../stores/explorer.store';
import {
  SIDEBAR_DEFAULT_WIDTH,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
import { usePinnedStore } from '../../stores/pinned.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
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
});

const fullSnapshotWithMainOwned: ExplorerSnapshot = {
  version: 3,
  workspace: { recentRoots: ['/work'] },
  pinned: { paths: ['/work/pinned.md'] },
  nextWindowSeq: 1,
  windows: [
    {
      windowSeq: 0,
      workspace: { root: '/work' },
      explorer: {
        activePath: '/work/a.md',
        expandedPaths: ['/work'],
        sort: { by: 'name', reverse: false },
      },
      layoutUi: { sidebarOpen: false, sidebarWidth: 320 },
      layout: { version: 1, dock: { panels: [] } },
      lastClosedAt: 123,
    },
  ],
};

describe('window-scoped layout IPC', () => {
  it('T12: renderer writes v3 writable snapshot without main-owned fields and hydrates full v3', () => {
    expect(() => hydrateStores(fullSnapshotWithMainOwned)).not.toThrow();
    expect(useWorkspaceStore.getState().root).toBe('/work');
    expect(useExplorerStore.getState().activePath).toBe('/work/a.md');

    useWorkspaceStore.setState({ root: '/renderer', recentRoots: ['/renderer'] });
    useExplorerStore.setState({
      activePath: '/renderer/b.md',
      expandedPaths: new Set(['/renderer']),
      sort: { by: 'mtime', reverse: true },
    });
    const writable = snapshotFromStores(fullSnapshotWithMainOwned);
    const w0 = writable.windows[0]! as unknown as Record<string, unknown>;

    expect(writable.version).toBe(3);
    expect(w0).not.toHaveProperty('layout');
    expect(w0).not.toHaveProperty('lastClosedAt');
    expect(writable.windows[0]!.workspace.root).toBe('/renderer');
    expect(writable.windows[0]!.explorer.activePath).toBe('/renderer/b.md');
  });

  it.todo('T9: layout:read resolves the current BrowserWindow from event.sender');
  it.todo('T10: layout:write persists only the sender window layout');
  it.todo('T13: explorer:write cannot overwrite layout data for another window');
  it.todo('T16: multi-window mocks keep two layouts independent');
  it.todo('T25: IPC failures expose stable coded errors');
});
