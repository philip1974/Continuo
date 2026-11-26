// 在本窗口打开文件夹前的去重(VSCode:打开一个已在某窗口打开的文件夹 → 聚焦那个窗口,当前窗口不变)。
// 判定与聚焦都在 main(window:focus-workspace-window,realpath + 平台语义比较各主窗口的 root)。
// 调用方:「最近打开」(open-recent-root)、打开文件夹…(selectWorkspaceFolder,含 ⌘O 命令)、拖文件夹进窗口(App)。
// BDD: src/__tests__/workspace-window-dedupe/

import { coApi } from '@/lib/co-api';

/**
 * 文件夹已在别的主窗口打开 → main 已聚焦那个窗口,返回 true(调用方不再改本窗口的 root);否则 false。
 * IPC 失败 / 拒绝按「没在别处打开」处理:只是少了去重,不让打开文件夹本身失效。
 */
export async function focusWindowIfWorkspaceOpen(path: string): Promise<boolean> {
  try {
    const r = await coApi.window.focusWorkspaceWindow(path);
    return r.ok && r.data === true;
  } catch {
    return false;
  }
}
