// @vitest-environment jsdom
// topic 49 第十三轮 · P2-AF:切 root 后第一次折叠/展开不丢前一个 root 的展开状态。
//
// 根因:expandedPaths 是窗口内跨 root 共享的单一扁平 Set(explorer.store,无按 root 分键)。
// FolderTree 只把 isWithinRoot(root) 过滤后的子集作为受控 state 喂给 headless-tree,
// 但回写时 headless-tree 只会给 in-root 路径数组(它内部 state 就是过滤后的子集),
// 旧 setExpandedItems 直接 setPersistedExpandedPaths(next) **整体替换** store →
// 其它 root(如上一个打开的 root A)的展开路径被静默丢弃。且 `current` 读取整个 store
// 是死代码(headless-tree 从不传函数 updater)。
//
// 触发:打开 A 展开若干 → 切 root 到 B(setRoot 不清 expandedPaths)→ 在 B 折叠/展开
// 任一节点 → store 被替换成 B-only,A 的展开从内存 + explorer.json 一并丢失,切回 A 全收起。
//
// 修复:setExpandedItems 保留 store 里 out-of-root 的部分,只更新 in-root 段;
// 函数 updater(若有)也喂 in-root 子集(与 headless-tree 视图一致),消除死读。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { TreeConfig } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';
import { useExplorerStore } from '../../stores/explorer.store';

const useTreeMock = vi.hoisted(() => vi.fn());

vi.mock('@headless-tree/react', () => ({ useTree: useTreeMock }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [] }),
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
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: vi.fn(async () => ({ ok: true })) }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

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
    activePath: null,
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
    search: '',
  });
  useTreeMock.mockImplementation(fakeTree);
});
afterEach(() => {
  cleanup();
  useTreeMock.mockReset();
});

describe('topic49 P2-AF · 切 root 保留前一 root 的展开状态', () => {
  it('在 /work 折叠节点时,/other/root(上一个 root 的展开)被保留', () => {
    useExplorerStore.setState({
      expandedPaths: new Set(['/work/src', '/other/root']),
    });
    render(<FolderTree root="/work" />);

    const config = useTreeMock.mock.calls[0]![0] as TreeConfig<FileEntry>;
    // headless-tree 视图里只有 in-root 子集 ['/work','/work/src'];用户折叠 /work/src →
    // 回写只含 in-root 的 ['/work']
    config.setExpandedItems?.(['/work']);

    const after = useExplorerStore.getState().expandedPaths;
    // out-of-root 的 /other/root 必须保留
    expect(after.has('/other/root')).toBe(true);
    // in-root 段按回写更新:/work 在,/work/src 已折叠
    expect(after.has('/work')).toBe(true);
    expect(after.has('/work/src')).toBe(false);
  });

  it('在 /work 新展开节点时,in-root 增量与 out-of-root 都在', () => {
    useExplorerStore.setState({
      expandedPaths: new Set(['/work', '/other/root']),
    });
    render(<FolderTree root="/work" />);

    const config = useTreeMock.mock.calls[0]![0] as TreeConfig<FileEntry>;
    config.setExpandedItems?.(['/work', '/work/lib']);

    const after = useExplorerStore.getState().expandedPaths;
    expect(after).toEqual(
      new Set(['/work', '/work/lib', '/other/root']),
    );
  });
});
