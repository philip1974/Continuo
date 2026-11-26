// 资源管理器的键盘入口命令(VSCode explorer.newFile / explorer.newFolder / workbench.action.files.openFolder /
// workbench.view.explorer),由 ExplorerTabPlugin 注册。新建复用 FolderTree 的 creating 流程、打开文件夹复用
// selectWorkspaceFolder:命令只发请求,FolderTree 订阅后在自己的状态里兑现。
// 另有标题栏动作的命令(VSCode 同名):折叠 / 刷新(发请求给文件树)、关闭文件夹(同标题栏菜单),无工作区时无操作
//(BDD: src/__tests__/command-discoverability/)。
//
// 默认键取舍:
//   - 新建文件 / 新建文件夹无默认键(同 VSCode:explorer.newFile / newFolder 无默认键;⌘N 在 VSCode 是
//     newUntitledFile,Continuo 没有 untitled 编辑器,不占用)。
//   - 打开文件夹 mod+O(VSCode mac ⌘O = 打开文件 / 文件夹;Continuo 无「打开文件」,⌘O 只开文件夹)。
//   - 显示资源管理器 mod+shift+E(同 VSCode)。
// BDD: src/__tests__/explorer-commands/

import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { focusWorkbenchPart } from '@/shell/focus-parts';
import { selectWorkspaceFolder } from './hooks/useSelectWorkspaceFolder';
import { requestExplorer } from './explorer-requests';
import { cancelPendingWorkspaceRootSelection } from '@/lib/workspace-root-guard';

export const NEW_FILE_COMMAND_ID = 'explorer.newFile';
export const NEW_FOLDER_COMMAND_ID = 'explorer.newFolder';
export const OPEN_FOLDER_COMMAND = { id: 'workbench.action.files.openFolder', hotkey: 'mod+o' } as const;
export const SHOW_EXPLORER_COMMAND = { id: 'workbench.view.explorer', hotkey: 'mod+shift+e' } as const;

/** 显示资源管理器并聚焦:有工作区 → 树的焦点行(等文件树加载);无 → 空态的「打开文件夹」。 */
export function showExplorer(): void {
  useLayoutUiStore.getState().setSidebarOpen(true);
  const root = useWorkspaceStore.getState().root;
  if (root) requestExplorer({ kind: 'focusTree', root });
  // 无工作区:等侧栏渲染出来(下一帧)再按 F6 的侧栏规则聚焦(第一个控件 =「打开文件夹」)。
  else requestAnimationFrame(() => focusWorkbenchPart('sidebar'));
}

/** 关闭文件夹(标题栏菜单与命令共用):回到未打开工作区。 */
export function closeWorkspaceFolder(): void {
  // race(R28):关闭文件夹是同步 root 变更,须先作废所有在途异步 root 选择,否则
  // 迟到的 open/drop/recent resolve 仍会 setRoot(oldPath) 撤销关闭、持久化写错 root。
  cancelPendingWorkspaceRootSelection();
  useWorkspaceStore.getState().setRoot(null);
}

/** 有工作区才把折叠 / 刷新请求发给文件树。 */
function requestTreeAction(kind: 'collapseAll' | 'refresh'): void {
  if (useWorkspaceStore.getState().root) requestExplorer({ kind });
}

function createInExplorer(type: 'file' | 'dir'): void {
  if (!useWorkspaceStore.getState().root) {
    showExplorer();
    return;
  }
  useLayoutUiStore.getState().setSidebarOpen(true);
  requestExplorer({ kind: 'create', type });
}

export function explorerCommandSpecs(): CommandSpec[] {
  return [
    {
      id: NEW_FILE_COMMAND_ID,
      title: 'New File…',
      titleKey: 'commands.explorer.new_file.title',
      category: 'Explorer',
      categoryKey: 'commands.explorer.category',
      fn: () => createInExplorer('file'),
    },
    {
      id: NEW_FOLDER_COMMAND_ID,
      title: 'New Folder…',
      titleKey: 'commands.explorer.new_folder.title',
      category: 'Explorer',
      categoryKey: 'commands.explorer.category',
      fn: () => createInExplorer('dir'),
    },
    {
      ...OPEN_FOLDER_COMMAND,
      title: 'Open Folder…',
      titleKey: 'commands.file.open_folder.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: async () => {
        // 选定后焦点交给新文件树(selectWorkspaceFolder 内发 focusTree 请求),先确保侧栏可见。
        await selectWorkspaceFolder({ onSelected: () => useLayoutUiStore.getState().setSidebarOpen(true) });
      },
    },
    {
      ...SHOW_EXPLORER_COMMAND,
      title: 'Show Explorer',
      titleKey: 'commands.view.show_explorer.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: showExplorer,
    },
    {
      id: 'workbench.files.action.collapseExplorerFolders',
      title: 'Collapse Folders in Explorer',
      titleKey: 'commands.explorer.collapse_folders.title',
      category: 'Explorer',
      categoryKey: 'commands.explorer.category',
      fn: () => requestTreeAction('collapseAll'),
    },
    {
      id: 'workbench.files.action.refreshFilesExplorer',
      title: 'Refresh Explorer',
      titleKey: 'commands.explorer.refresh.title',
      category: 'Explorer',
      categoryKey: 'commands.explorer.category',
      fn: () => requestTreeAction('refresh'),
    },
    {
      id: 'workbench.action.closeFolder',
      title: 'Close Folder',
      titleKey: 'commands.file.close_folder.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: () => {
        if (useWorkspaceStore.getState().root) closeWorkspaceFolder();
      },
    },
  ];
}
