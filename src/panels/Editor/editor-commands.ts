// 工作台编辑器命令(对齐 VSCode 同名命令):
// - workbench.action.closeActiveEditor(⌘W):关当前文件 tab / 其它活动面板,无可关的才关窗口;
// - workbench.action.files.save(⌘S):保存当前活动文件 tab,焦点在哪都生效;
// - workbench.action.files.revert:还原当前活动文件 tab 为磁盘内容(丢弃未保存修改;同 VSCode 无默认键);
// - workbench.action.nextEditor / previousEditor:编辑器文件 tab 间循环切换。
// 保存与「关当前 tab」依赖 EditorPanel 内的确认框状态(覆盖确认 / 保存·不保存·取消),由面板挂载时注册实现;
// 本模块只依赖 store / dock api,不静态引入编辑器引擎(EditorPlugin 在启动路径上 import 本模块)。
// BDD: src/__tests__/workbench-editor-commands/

import { useEditorStore, findEditorTabIndexById } from '@/stores/editor.store';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { coApi } from '@/lib/co-api';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { revertFile } from './editor-file-actions';
import { editorFileDeps } from './editor-file-deps';
import { findEditorFileTabById } from './editor-tab-lookup';
import type { Platform } from '@/plugins/command-palette/format-hotkey';

/** 命令 id 与默认键(终端按生效绑定让出 ⌘W / ⌘S 时与此约定一致)。 */
export const CLOSE_ACTIVE_EDITOR_COMMAND = { id: 'workbench.action.closeActiveEditor', hotkey: 'mod+w' } as const;
export const SAVE_COMMAND = { id: 'workbench.action.files.save', hotkey: 'mod+s' } as const;
export const NEXT_EDITOR_COMMAND_ID = 'workbench.action.nextEditor';
export const PREVIOUS_EDITOR_COMMAND_ID = 'workbench.action.previousEditor';
export const REVERT_COMMAND_ID = 'workbench.action.files.revert';

/** EditorPanel 提供的动作(依赖面板内确认框状态)。 */
export interface EditorPanelActions {
  /** 显式保存当前活动 tab(磁盘已被外部修改 → 弹覆盖确认;其它失败按 code 提示)。 */
  readonly save: () => Promise<void>;
  /** 按 tab × 同一路径关闭当前活动 tab;无活动 tab → false。 */
  readonly closeActiveTab: () => boolean;
}

let panelActions: EditorPanelActions | null = null;

/** EditorPanel 挂载时注册;返回的 disposer 只注销自己注册的那份(重挂载时不误删新实例)。 */
export function registerEditorPanelActions(actions: EditorPanelActions): () => void {
  panelActions = actions;
  return () => {
    if (panelActions === actions) panelActions = null;
  };
}

/** 保存当前活动文件 tab(编辑器面板未挂载 → no-op)。 */
export async function saveActiveEditor(): Promise<void> {
  await panelActions?.save();
}

/** 还原当前活动文件 tab 为磁盘内容(无活动 tab → no-op;读盘失败按 code 提示,tab 不变)。 */
export async function revertActiveEditor(): Promise<void> {
  const { tabs, activeTabId } = useEditorStore.getState();
  const tab = findEditorFileTabById(tabs, activeTabId);
  if (!tab) return;
  const r = await revertFile(tab.id, editorFileDeps);
  if (!r.ok) notifyFailure(r);
}

/**
 * ⌘W:dock 活动面板是编辑器且有活动文件 tab → 关该 tab;其它面板 / 编辑器已无 tab → 关闭该面板
 *(panel.api.close:与 dock tab × 同一路径,含面板自己的关闭守卫);没有可关的面板 → 关闭当前窗口。
 */
export function closeActiveEditor(): void {
  const active = getDockApi()?.activePanel;
  if (!active) {
    void coApi.window.close().then((r) => {
      if (!r.ok) notifyFailure(r);
    });
    return;
  }
  if (active.view.contentComponent === 'editor' && panelActions?.closeActiveTab()) return;
  active.api.close();
}

/** 切到相邻编辑器文件 tab(首尾相接);tab 数 < 2 → no-op。 */
export function openAdjacentEditor(delta: 1 | -1): void {
  const { tabs, activeTabId, switchTab } = useEditorStore.getState();
  if (tabs.length < 2) return;
  const index = activeTabId === null ? -1 : findEditorTabIndexById(tabs, activeTabId);
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index;
  switchTab(tabs[(from + delta + tabs.length) % tabs.length]!.id);
}

/**
 * 命令 spec(EditorPlugin 注册)。下一个 / 上一个编辑器的默认键按平台对齐 VSCode:
 * mac ⌥⌘→ / ⌥⌘←,其它 Ctrl+PageDown / Ctrl+PageUp。
 */
export function editorCommandSpecs(platform: Platform): CommandSpec[] {
  const isMac = platform === 'mac';
  return [
    {
      ...CLOSE_ACTIVE_EDITOR_COMMAND,
      title: 'Close Editor',
      titleKey: 'commands.editor.close.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: closeActiveEditor,
    },
    {
      ...SAVE_COMMAND,
      title: 'Save',
      titleKey: 'commands.file.save.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: saveActiveEditor,
    },
    {
      id: REVERT_COMMAND_ID,
      title: 'Revert File',
      titleKey: 'commands.file.revert.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: revertActiveEditor,
    },
    {
      id: NEXT_EDITOR_COMMAND_ID,
      title: 'Open Next Editor',
      titleKey: 'commands.editor.next.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      hotkey: isMac ? 'mod+alt+right' : 'ctrl+pagedown',
      fn: () => openAdjacentEditor(1),
    },
    {
      id: PREVIOUS_EDITOR_COMMAND_ID,
      title: 'Open Previous Editor',
      titleKey: 'commands.editor.previous.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      hotkey: isMac ? 'mod+alt+left' : 'ctrl+pageup',
      fn: () => openAdjacentEditor(-1),
    },
  ];
}
