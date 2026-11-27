// 从 Finder / 桌面拖入磁盘文件(对齐 VSCode ResourcesDropHandler:外部文件一律在编辑器里打开,图片打开图片预览;
// 按住 ⇧ 放到文本里才插入,由 codemirror-media-drop / milkdown-media-drop 处理)。BDD: src/__tests__/os-file-drop/
// 谁先收到事件谁先处理:编辑器内容认领插入的文件 → 编辑器面板(EditorPanel onDrop)打开剩下的 → 窗口级(App)打开仍未认领的。
import {
  MAX_DROP_FILES,
  captureDroppedRegularFiles,
  claimDroppedFiles,
  unclaimedDroppedFiles,
} from '@/lib/window-drop';
import { openDroppedFiles } from '@/shell/dock/explorer-editor-drop';
import { diskPathsOf, isOsFileDrop } from './editor-media-drop';

export type OpenOsDroppedFiles = (paths: readonly string[], groupId: string | undefined) => unknown;

/**
 * 这次 OS 文件拖放里还没被认领的普通文件的磁盘路径,并认领它们(drop 回调里同步调用:DataTransfer 只在事件期间可读)。
 * 不是 OS 文件拖放 / 有文件夹(由窗口级打开为工作区,同 VSCode 拖入文件夹)/ 都已认领 → []。
 */
export function takeUnclaimedDroppedPaths(event: DragEvent): string[] {
  const dt = event.dataTransfer;
  if (!isOsFileDrop(dt)) return [];
  const { files, hadDirectory } = captureDroppedRegularFiles(dt!, MAX_DROP_FILES);
  if (hadDirectory) return [];
  const pending = unclaimedDroppedFiles(event, files);
  if (pending.length === 0) return [];
  claimDroppedFiles(event, pending);
  return diskPathsOf(pending);
}

/**
 * 打开这次 OS 文件拖放里还没被认领的普通文件(groupId:落点所在的编辑器组;undefined = 活动编辑器组)。返回是否打开了文件。
 */
export function openOsDroppedFiles(
  event: DragEvent,
  groupId: string | undefined,
  open: OpenOsDroppedFiles = openDroppedFiles,
): boolean {
  const paths = takeUnclaimedDroppedPaths(event);
  if (paths.length === 0) return false;
  event.preventDefault(); // 不让浏览器把文件当页面打开(popout 子窗没有窗口级监听兜底)
  void open(paths, groupId);
  return true;
}
