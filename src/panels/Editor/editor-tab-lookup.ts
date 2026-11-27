import { isMacRuntime, pathEquals } from '@/lib/path-cross';
import type { EditorTab } from '@/stores/editor.store';

/**
 * 按打开路径找 tab(平台感知 pathEquals)。macOS 上再按 NFC 归一比一次(原样命中优先):APFS / HFS+ 不区分 Unicode 规范化形式,
 * 同一文件经 NFD 路径(资源管理器 / 搜索 / Quick Open 用磁盘原样名,如韩文文件名)与 NFC 路径(终端里键入的路径、插件 / 命令行给的路径)
 * 打开时不能开成两个 tab(各自编辑保存会互相覆盖)。Windows / Linux 的文件系统区分规范化形式,不折叠。
 */
export function findEditorFileTabByPath(
  tabs: readonly EditorTab[],
  path: string,
): EditorTab | null {
  for (const tab of tabs) {
    if (pathEquals(tab.filePath, path)) return tab;
  }
  if (!isMacRuntime()) return null;
  const nfc = path.normalize('NFC');
  for (const tab of tabs) {
    if (tab.filePath.normalize('NFC') === nfc) return tab;
  }
  return null;
}

/**
 * tab 是否对应磁盘路径 p:比较打开拼写 filePath 或读盘解析出的 realPath(symlink / 经 /tmp → /private/tmp 等
 * 非 canonical 路径打开时两者不同,外部来源如 watcher / debug adapter 报的可能是任一侧)。
 */
export function tabMatchesDiskPath(
  tab: Pick<EditorTab, 'filePath' | 'realPath'>,
  p: string,
): boolean {
  return (
    pathEquals(tab.filePath, p) ||
    (tab.realPath !== undefined && pathEquals(tab.realPath, p))
  );
}

/** 按 id 找 tab;id 为 null(无 active tab)→ null。 */
export function findEditorFileTabById(
  tabs: readonly EditorTab[],
  tabId: string | null,
): EditorTab | null {
  if (tabId === null) return null;
  for (const tab of tabs) {
    if (tab.id === tabId) return tab;
  }
  return null;
}
