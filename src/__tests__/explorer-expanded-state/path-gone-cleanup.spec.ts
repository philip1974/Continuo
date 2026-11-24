// 路径已移走 / 已删除的清理收口:editor tab、剪贴板、展开集合三份状态一次更新。
// 缺陷:FolderTree 三个入口(改名 / 批量移动·粘贴·拖动 / 移到回收站)各自手写清理,都漏了
// explorer.store 的 expandedPaths → 改名后新目录折叠、旧路径留在持久化展开集合里,刷新与
// watcher 对旧路径 listDir / watchDir 反复失败。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupAfterPathMoved,
  cleanupAfterPathsRemoved,
} from '../../panels/Explorer/path-gone-cleanup';
import { useEditorStore } from '../../stores/editor.store';
import { useExplorerStore } from '../../stores/explorer.store';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';

beforeEach(() => {
  useExplorerStore.getState().setExpandedPaths(['/r', '/r/foo', '/r/foo/sub', '/r/other']);
  useExplorerClipboardStore.getState().set('cut', ['/r/foo/f.txt', '/r/other/g.txt']);
});

afterEach(() => {
  vi.restoreAllMocks();
  useExplorerStore.getState().setExpandedPaths([]);
  useExplorerClipboardStore.setState({ kind: null, paths: [] });
});

describe('cleanupAfterPathMoved', () => {
  it('editor 改写路径、展开集合前缀改写(保留展开)、剪贴板剪除旧路径', () => {
    const renamePath = vi.spyOn(useEditorStore.getState(), 'renamePath');
    cleanupAfterPathMoved('/r/foo', '/r/bar');
    expect(renamePath).toHaveBeenCalledWith('/r/foo', '/r/bar');
    expect(useExplorerStore.getState().expandedPaths).toEqual(
      new Set(['/r', '/r/bar', '/r/bar/sub', '/r/other']),
    );
    expect(useExplorerClipboardStore.getState().paths).toEqual(['/r/other/g.txt']);
  });
});

describe('cleanupAfterPathsRemoved', () => {
  it('editor 关闭、展开集合删除路径及后代、剪贴板剪除', () => {
    const removePaths = vi.spyOn(useEditorStore.getState(), 'removePaths');
    cleanupAfterPathsRemoved(['/r/foo']);
    expect(removePaths).toHaveBeenCalledWith(['/r/foo']);
    expect(useExplorerStore.getState().expandedPaths).toEqual(new Set(['/r', '/r/other']));
    expect(useExplorerClipboardStore.getState().paths).toEqual(['/r/other/g.txt']);
  });
});

// 接线守卫:三个入口只调清理函数,不再各自手写(防「补一处漏一处」复发)。
describe('FolderTree 接线', () => {
  const SRC = readFileSync(
    join(__dirname, '..', '..', 'panels', 'Explorer', 'FolderTree.tsx'),
    'utf-8',
  );

  it('改名与批量移动走 cleanupAfterPathMoved,回收站走 cleanupAfterPathsRemoved', () => {
    // 经 onPathMoved / onPathsRemoved 包一层:清理之外还改写「全部展开」批量期暂存的展开数组。
    expect(SRC).toMatch(/onPathMoved\(oldPath, r\.newPath\)/);
    expect(SRC).toMatch(/onMoved: onPathMoved/);
    expect(SRC).toMatch(/trashItemsAndCleanup\(paths, mutateDeps, treeApi, onPathsRemoved\)/);
    expect(SRC).toMatch(/cleanupAfterPathMoved\(oldPath, newPath\)/);
    expect(SRC).toMatch(/cleanupAfterPathsRemoved\(paths\)/);
  });

  it('FolderTree 不再直接调 editor renamePath/removePaths 或剪贴板 prune', () => {
    expect(SRC).not.toMatch(/\.renamePath\(/);
    expect(SRC).not.toMatch(/\.removePaths\(/);
    expect(SRC).not.toMatch(/\.prune\(/);
  });
});
