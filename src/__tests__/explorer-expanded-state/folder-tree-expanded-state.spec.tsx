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
import { t } from '@/i18n';

// a11y(A25):捕获 getContainerProps 的 treeLabel 实参,验证 FolderTree 给 role=tree 传可访问名。
const getContainerPropsSpy = vi.fn(() => ({}));

function fakeTree(config: TreeConfig<FileEntry>) {
  return {
    getItems: () => [],
    getState: () => ({
      selectedItems: [],
      expandedItems: config.state?.expandedItems ?? [],
    }),
    getContainerProps: getContainerPropsSpy,
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

// a11y(A25):headless-tree role="tree" 默认 aria-label="" → 须经 getContainerProps(treeLabel)
// 给主文件树一个可访问名。getContainerProps 仅在 items 非空(渲染 tree 容器)时调用。
describe('FolderTree · a11y(A25) tree 可访问名', () => {
  it('给 role=tree 容器传本地化 aria-label', () => {
    getContainerPropsSpy.mockClear();
    useTreeMock.mockImplementation((config: TreeConfig<FileEntry>) => ({
      ...fakeTree(config),
      // 非空 items → 渲染 tree 容器(virtualizer 仍 mock 空,不渲染 FileRow)
      getItems: () => [{ getItemData: () => ({ name: 'a.txt' }) }],
    }));
    render(<FolderTree root="/work" />);
    expect(getContainerPropsSpy).toHaveBeenCalledWith(
      t('panels.explorer.tree_aria'),
    );
  });
});
