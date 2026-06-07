// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { useExplorerStore } from '../../stores/explorer.store';
import {
  SIDEBAR_DEFAULT_WIDTH,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
import { usePinnedStore } from '../../stores/pinned.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  initExplorerPersistence,
  type EditorSessionFsApi,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
  type ExplorerWindowEntry,
} from '../../lib/persist/explorer-persist';

function resetAll(): void {
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
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
}

beforeEach(resetAll);

function makeApi(snap: ExplorerSnapshot | null): ExplorerPersistApi {
  return {
    read: vi.fn(async () => ({ ok: true as const, data: snap })),
    write: vi.fn(async () => ({ ok: true as const, data: undefined })),
  };
}

function makeFs(files: Record<string, string>): EditorSessionFsApi {
  return {
    readFile: vi.fn(async (path: string) => {
      const content = files[path];
      if (content === undefined) {
        return { ok: false as const, code: 'FS_ENOENT', message: 'not found' };
      }
      return { ok: true as const, data: content };
    }),
  };
}

function entry(opts: {
  windowSeq: number;
  root: string | null;
  activePath?: string | null;
  expandedPaths?: string[];
  editor?: { openFilePaths: string[]; activePath: string | null };
}): ExplorerWindowEntry {
  return {
    windowSeq: opts.windowSeq,
    workspace: { root: opts.root },
    explorer: {
      activePath: opts.activePath ?? null,
      expandedPaths: opts.expandedPaths ?? [],
      sort: { by: 'name', reverse: false },
    },
    layoutUi: { sidebarOpen: false, sidebarWidth: 320 },
    ...(opts.editor ? { editor: opts.editor } : {}),
  };
}

function snap(opts: {
  recentRoots: string[];
  windows: ExplorerWindowEntry[];
}): ExplorerSnapshot {
  return {
    version: 3,
    workspace: { recentRoots: opts.recentRoots },
    pinned: { paths: [] },
    nextWindowSeq: 2,
    windows: opts.windows,
  };
}

describe('cold-start drag folder', () => {
  it('fresh + persisted entry overrides root and does not reopen editor tabs', async () => {
    const data = snap({
      recentRoots: ['/old'],
      windows: [
        entry({
          windowSeq: 0,
          root: '/old',
          activePath: '/old/a.md',
          expandedPaths: ['/old'],
          editor: { openFilePaths: ['/old/a.md'], activePath: '/old/a.md' },
        }),
      ],
    });
    const fs = makeFs({ '/old/a.md': 'old' });

    await initExplorerPersistence(makeApi(data), {
      fs,
      windowSeq: 0,
      initialWorkspace: '/dragged',
      fresh: true,
    });

    expect(useWorkspaceStore.getState().root).toBe('/dragged');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/old']);
    expect(useExplorerStore.getState().activePath).toBeNull();
    expect(useExplorerStore.getState().expandedPaths.size).toBe(0);
    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('fresh + null snap uses initialWorkspace on first launch', async () => {
    await initExplorerPersistence(makeApi(null), {
      windowSeq: 0,
      initialWorkspace: '/dragged',
      fresh: true,
    });

    expect(useWorkspaceStore.getState().root).toBe('/dragged');
  });

  it('no query restores persisted primary window unchanged', async () => {
    const data = snap({
      recentRoots: ['/old'],
      windows: [entry({ windowSeq: 0, root: '/old' })],
    });

    await initExplorerPersistence(makeApi(data), { windowSeq: 0 });

    expect(useWorkspaceStore.getState().root).toBe('/old');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/old']);
  });

  it('restore-loop workspace query without fresh restores existing entry', async () => {
    const data = snap({
      recentRoots: ['/restore'],
      windows: [
        entry({ windowSeq: 0, root: '/old' }),
        entry({
          windowSeq: 1,
          root: '/restore',
          expandedPaths: ['/restore'],
          editor: {
            openFilePaths: ['/restore/x.ts'],
            activePath: '/restore/x.ts',
          },
        }),
      ],
    });
    const fs = makeFs({ '/restore/x.ts': 'x' });

    await initExplorerPersistence(makeApi(data), {
      fs,
      windowSeq: 1,
      initialWorkspace: '/restore',
    });

    expect(useWorkspaceStore.getState().root).toBe('/restore');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/restore']);
    expect(useExplorerStore.getState().expandedPaths).toEqual(
      new Set(['/restore']),
    );
    expect(useEditorStore.getState().tabs.map((t) => t.filePath)).toEqual([
      '/restore/x.ts',
    ]);
  });

  it('restore-loop workspace query without fresh falls back when entry is missing', async () => {
    const data = snap({
      recentRoots: ['/old'],
      windows: [entry({ windowSeq: 0, root: '/old' })],
    });

    await initExplorerPersistence(makeApi(data), {
      windowSeq: 1,
      initialWorkspace: '/restore',
    });

    expect(useWorkspaceStore.getState().root).toBe('/restore');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/old']);
  });

  it('workspace query without fresh does not override an existing entry', async () => {
    const data = snap({
      recentRoots: ['/old'],
      windows: [entry({ windowSeq: 0, root: '/old' })],
    });

    await initExplorerPersistence(makeApi(data), {
      windowSeq: 0,
      initialWorkspace: '/dragged',
    });

    expect(useWorkspaceStore.getState().root).toBe('/old');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/old']);
  });
});
