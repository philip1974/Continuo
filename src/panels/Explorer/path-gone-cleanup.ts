// Explorer「路径已移走 / 已删除」后的状态清理单一出口:editor tab、剪贴板、展开集合三份状态一次更新。
// 此前改名 / 批量移动(粘贴、拖动)/ 移到回收站三个入口各自手写,都漏了持久化的展开集合 → 旧路径
// 留在 expandedPaths:改名后新目录折叠,刷新与 watcher 对旧路径 listDir / watchDir 反复失败,重启后依旧。

import { useEditorStore } from '@/stores/editor.store';
import { useExplorerStore } from '@/stores/explorer.store';
import { useExplorerClipboardStore } from './clipboard-store';

/** oldPath 已改名 / 移动到 newPath(目录则其下全部路径同前缀改写)。 */
export function cleanupAfterPathMoved(oldPath: string, newPath: string): void {
  useEditorStore.getState().renamePath(oldPath, newPath);
  useExplorerStore.getState().renameExpanded(oldPath, newPath);
  // 旧路径已不存在 → 剪除剪贴板里引用它的 cut/copy 项。
  useExplorerClipboardStore.getState().prune([oldPath]);
}

/** 这些路径已删除(目录则含其下全部路径)。 */
export function cleanupAfterPathsRemoved(paths: string[]): void {
  useEditorStore.getState().removePaths(paths);
  useExplorerStore.getState().forgetExpanded(paths);
  useExplorerClipboardStore.getState().prune(paths);
}
