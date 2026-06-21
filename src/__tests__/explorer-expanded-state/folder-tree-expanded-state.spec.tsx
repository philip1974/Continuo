// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { TreeConfig } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const useTreeMock = vi.hoisted(() => vi.fn());

vi.mock('@headless-tree/react', () => ({
  useTree: useTreeMock,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
  }),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async () => ({ ok: true, data: [] })),
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    terminal: {
      create: vi.fn(),
    },
  },
}));

vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({
    openFileByPath: vi.fn(async () => ({ ok: true })),
  }),
}));

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));

vi.mock('@/theme', () => ({
  useTheme: () => ({ resolved: 'dark' }),
}));

import { FolderTree } from '../../panels/Explorer/FolderTree';

function fakeTree(config: TreeConfig<FileEntry>) {
  return {
    getItems: () => [],
    getState: () => ({
      selectedItems: [],
      expandedItems: config.state?.expandedItems ?? [],
    }),
    getContainerProps: () => ({}),
    getItemInstance: () => ({
      invalidateChildrenIds: vi.fn(),
      startRenaming: vi.fn(),
    }),
    rebuildTree: vi.fn(),
    expandAll: vi.fn(),
    collapseAll: vi.fn(),
  };
}

beforeEach(() => {
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
  useTreeMock.mockImplementation(fakeTree);
});

afterEach(() => {
  cleanup();
  useTreeMock.mockReset();
});

describe('FolderTree · expandedPaths 持久化接入', () => {
  it('把 store.expandedPaths 注入 headless-tree state,并保留 root 展开', () => {
    useExplorerStore.setState({
      expandedPaths: new Set(['/work/src', '/other/root']),
    });

    render(<FolderTree root="/work" />);

    const config = useTreeMock.mock.calls[0]![0] as TreeConfig<FileEntry>;
    expect(config.state?.expandedItems).toEqual(['/work', '/work/src']);
  });

  it('headless-tree setExpandedItems 会写回 store.expandedPaths', () => {
    render(<FolderTree root="/work" />);

    const config = useTreeMock.mock.calls[0]![0] as TreeConfig<FileEntry>;
    config.setExpandedItems?.(['/work', '/work/src']);

    expect(useExplorerStore.getState().expandedPaths).toEqual(
      new Set(['/work', '/work/src']),
    );
  });
});
