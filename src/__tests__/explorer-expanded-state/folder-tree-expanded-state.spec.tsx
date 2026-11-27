// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      rename: vi.fn(async (_old: string, name: string) => ({ ok: true, data: `/work/${name}` })),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
      onRootPresenceChanged: vi.fn(() => vi.fn()),
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
  it('构建/回写 expandedItems 不通过 Set+spread 生成中间结构', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/panels/Explorer/FolderTree.tsx'),
      'utf-8',
    );

    expect(src).not.toContain('new Set<string>([root])');
    expect(src).not.toContain('return [...next]');
    expect(src).not.toContain('setPersistedExpandedPaths([...outOfRoot, ...next])');
    expect(src).not.toContain('(isWithinRoot(p, root) ? inRootCurrent : outOfRoot).push(p)');
    expect(src).toContain('new Array<string>(expandedPaths.size)');
  });

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

// 「全部展开」批量期:库每步整份回传展开数组(可能还在展开旧子树的后代),批末整体写回 store。期间完成的改名
// 须在写回前重放,否则旧路径(及其后代)被写回展开集合。
describe('FolderTree · 全部展开期间改名', () => {
  it('批量期改名后库继续回传旧路径 → 批末写回的是改名后的路径', async () => {
    let finish!: () => void;
    const tree = (config: TreeConfig<FileEntry>) => ({
      ...fakeTree(config),
      getConfig: () => config,
      // 改名成功后 refreshParent 读 dataRef 的子项缓存(缺则抛,成为未处理错误)。
      getDataRef: () => ({ current: {} }),
      expandAll: vi.fn(() => new Promise<void>((r) => (finish = r))),
    });
    useTreeMock.mockImplementation(tree);
    render(<FolderTree root="/work" />);
    fireEvent.click(screen.getByRole('button', { name: t('panels.explorer.btn.more_actions') }));
    fireEvent.click(screen.getByRole('menuitem', { name: t('panels.explorer.menu.expand_all') }));

    const config = () => useTreeMock.mock.calls.at(-1)![0] as TreeConfig<FileEntry>;
    act(() => config().setExpandedItems?.(['/work', '/work/old']));
    const { coApi } = await import('@/lib/co-api');
    act(() => config().onRename?.({ getId: () => '/work/old' } as never, 'new'));
    await waitFor(() => expect(coApi.fs.rename).toHaveBeenCalledWith('/work/old', 'new'));
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    // 库按旧内部状态继续展开旧子树的后代,整份回传(含旧路径)
    await act(async () => {
      await Promise.resolve();
      config().setExpandedItems?.(['/work', '/work/old', '/work/old/a']);
    });
    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect([...useExplorerStore.getState().expandedPaths].sort()).toEqual(['/work', '/work/new', '/work/new/a']);
  });
});

