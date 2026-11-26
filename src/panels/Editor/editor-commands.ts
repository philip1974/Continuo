// 工作台编辑器命令(对齐 VSCode 同名命令):
// - workbench.action.closeActiveEditor(⌘W):关当前文件 tab / 其它活动面板,无可关的才关窗口;
// - workbench.action.files.save(⌘S):保存当前活动文件 tab,焦点在哪都生效;
// - workbench.action.files.revert:还原当前活动文件 tab 为磁盘内容(丢弃未保存修改;同 VSCode 无默认键);
// - workbench.action.reopenClosedEditor(⇧⌘T):重新打开最近关闭的编辑器(BDD: src/__tests__/editor-reopen-closed/);
// - workbench.action.nextEditor / previousEditor:编辑器文件 tab 间循环切换(活动编辑器组内);
// - workbench.action.splitEditor(⌘\)/ splitEditorDown(无默认键)/ focusFirst·Second·ThirdEditorGroup(⌘1 / ⌘2 / ⌘3):
//   编辑器组(BDD: src/__tests__/editor-groups/)。
// - 组内关闭类(closeOtherEditors / closeEditorsToTheRight / closeUnmodifiedEditors / closeEditorsInGroup)、copyFilePath /
//   copyRelativeFilePath / revealFileInOS、markdown.switchTo*Mode:tab 右键 / 模式切换的同一动作,作用于活动编辑器组的活动 tab
//   (BDD: src/__tests__/command-discoverability/)。
// 编辑器组类命令(保存 / 还原 / 拆分 / 组内关闭 / 复制路径 / 模式切换 / 相邻编辑器)作用于触发它的窗口的编辑器组
// (commandEditorGroupId;VSCode 同),不看全局活动编辑器组 —— 从子窗切回主窗时它可能仍在子窗。
// 保存与「关当前 tab」依赖 EditorPanel 内的确认框状态(覆盖确认 / 保存·不保存·取消),由面板挂载时注册实现;
// 本模块只依赖 store / dock api,不静态引入编辑器引擎(EditorPlugin 在启动路径上 import 本模块)。
// BDD: src/__tests__/workbench-editor-commands/

import {
  findEditorTabIndexById,
  groupActiveTabIdOf,
  groupTabsOf,
  useEditorStore,
  type EditorMode,
  type EditorTab,
} from '@/stores/editor.store';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import { commandEditorGroupId, focusEditorGroup, splitEditor } from './editor-groups-actions';
import type { IDockviewPanel } from 'dockview-react';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { activePanelInDocument, popoutGroupOfDocument } from '@/shell/dock/group-mru';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import { coApi } from '@/lib/co-api';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { revertFile } from './editor-file-actions';
import { reopenClosedEditor } from './reopen-closed-editor';
import { editorFileDeps } from './editor-file-deps';
import { findEditorFileTabById } from './editor-tab-lookup';
import { detectPlatform, formatHotkey, type Platform } from '@/plugins/command-palette/format-hotkey';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { resolveActiveHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { isHotkeyShadowed } from '@/plugins/command-palette/useCommandHotkeys';
import { coApp } from '@/plugins/co-app';
import { t, tWithFallback } from '@/i18n';
import { tabCloseTargets, type TabCloseKind } from '@/lib/tab-close-targets';
import { stripRootPrefix } from '@/lib/path-cross';
import { copyToClipboardOrNotify } from '@/panels/Explorer/copy-to-clipboard';
import { revealPathOrNotify } from '@/panels/Explorer/reveal-or-notify';
import { useWorkspaceStore } from '@/stores/workspace.store';

/** 命令 id 与默认键(终端按生效绑定让出 ⌘W / ⌘S 时与此约定一致)。 */
export const CLOSE_ACTIVE_EDITOR_COMMAND = { id: 'workbench.action.closeActiveEditor', hotkey: 'mod+w' } as const;
export const SAVE_COMMAND = { id: 'workbench.action.files.save', hotkey: 'mod+s' } as const;
export const NEXT_EDITOR_COMMAND_ID = 'workbench.action.nextEditor';
export const PREVIOUS_EDITOR_COMMAND_ID = 'workbench.action.previousEditor';
export const REVERT_COMMAND_ID = 'workbench.action.files.revert';
export const SPLIT_EDITOR_COMMAND = { id: 'workbench.action.splitEditor', hotkey: 'mod+\\' } as const;
/** 重新打开已关闭的编辑器(VSCode 同:⇧⌘T / Ctrl+Shift+T;BDD: src/__tests__/editor-reopen-closed/)。 */
export const REOPEN_CLOSED_EDITOR_COMMAND = { id: 'workbench.action.reopenClosedEditor', hotkey: 'mod+shift+t' } as const;
export const SPLIT_EDITOR_DOWN_COMMAND_ID = 'workbench.action.splitEditorDown';
/** 聚焦第 N 个编辑器组(N = 1..3)的命令 id 与默认键(VSCode 同:⌘1 / ⌘2 / ⌘3,其它平台 Ctrl+1 …)。 */
export const FOCUS_EDITOR_GROUP_COMMANDS = [
  { id: 'workbench.action.focusFirstEditorGroup', hotkey: 'mod+1', index: 1 },
  { id: 'workbench.action.focusSecondEditorGroup', hotkey: 'mod+2', index: 2 },
  { id: 'workbench.action.focusThirdEditorGroup', hotkey: 'mod+3', index: 3 },
] as const;

/**
 * 保存命令当前生效绑定的显示文本(按平台:⌘S / Ctrl+S),供提示文案的 `{hotkey}` 占位(「按 {hotkey} 选择覆盖」等):
 * 改绑后跟随,不写死 Cmd/Ctrl+S。未绑定 / 与别的命令冲突落败(按下不保存)→ 命令标题。
 */
export function saveHotkeyLabel(platform: Platform = detectPlatform()): string {
  const overrides = useKeybindingsStore.getState().overrides;
  const combo = isHotkeyShadowed(SAVE_COMMAND.id, coApp.commands.getAll(), platform, overrides)
    ? undefined
    : resolveActiveHotkey(SAVE_COMMAND, overrides, platform);
  return combo ? formatHotkey(combo, platform) : tWithFallback('commands.file.save.title', 'Save');
}

/** EditorPanel 提供的动作(依赖面板内确认框状态)。 */
export interface EditorPanelActions {
  /** 显式保存当前活动 tab(磁盘已被外部修改 → 弹覆盖确认;其它失败按 code 提示)。 */
  readonly save: () => Promise<void>;
  /** 按 tab × 同一路径关闭当前活动 tab;无活动 tab → false。 */
  readonly closeActiveTab: () => boolean;
  /** 按 tab 右键「关闭其他 / 右侧 / 已保存 / 全部」同一路径关闭这些 tab(脏 tab 弹确认)。 */
  readonly closeTabs: (ids: readonly string[]) => void;
}

// 按编辑器组(= 面板 id)登记:每个组面板各自一份。
const panelActions = new Map<string, EditorPanelActions>();

/** EditorPanel 挂载时注册;返回的 disposer 只注销自己注册的那份(重挂载时不误删新实例)。 */
export function registerEditorPanelActions(actions: EditorPanelActions, groupId: string = 'editor'): () => void {
  panelActions.set(groupId, actions);
  return () => {
    if (panelActions.get(groupId) === actions) panelActions.delete(groupId);
  };
}

// Markdown 模式切换(EditorPanel 的 requestModeChange:unsafe 文档确认框 / 较大文档渲染提示在面板内),同样按组登记。
const markdownModeActions = new Map<string, (mode: EditorMode) => void>();

/** EditorPanel 挂载时注册本组的模式切换(活动 tab 不是 Markdown 时传入的实现自己忽略);disposer 只注销自己那份。 */
export function registerMarkdownModeAction(fn: (mode: EditorMode) => void, groupId: string = 'editor'): () => void {
  markdownModeActions.set(groupId, fn);
  return () => {
    if (markdownModeActions.get(groupId) === fn) markdownModeActions.delete(groupId);
  };
}

/** 触发窗口的编辑器组面板的动作(该组面板未挂载 → 任一已挂载的组面板;该窗口没有编辑器组 → undefined)。 */
function activeGroupActions(): EditorPanelActions | undefined {
  const groupId = commandEditorGroupId();
  if (groupId === undefined) return undefined;
  return panelActions.get(groupId) ?? panelActions.values().next().value;
}

/** 保存活动编辑器组的活动文件 tab(编辑器面板未挂载 → no-op)。 */
export async function saveActiveEditor(): Promise<void> {
  await activeGroupActions()?.save();
}

/** 还原触发窗口的编辑器组的活动文件 tab 为磁盘内容(无活动 tab → no-op;读盘失败按 code 提示,tab 不变)。 */
export async function revertActiveEditor(): Promise<void> {
  const tab = activeGroupTab();
  if (!tab) return;
  const r = await revertFile(tab.id, editorFileDeps);
  if (!r.ok) notifyFailure(r);
}

/**
 * ⌘W:作用于触发它的窗口(按键所在窗口 / 命令面板所在的主窗;VSCode 同)的活动面板 —— 编辑器且有活动文件 tab → 关该 tab;
 * 其它面板 / 编辑器已无 tab → 关闭该面板(panel.api.close:与 dock tab × 同一路径,含面板自己的关闭守卫)。
 * 该窗口没有可关的面板 → 关闭该窗口:popout 子窗只关这个子窗,主窗走 window:close。不看全局 activePanel:从子窗切回
 * 主窗(或反过来)时它仍停在另一个窗口,⌘W 会关掉别的窗口的面板,子窗里更会关掉整个主窗。
 */
export function closeActiveEditor(): void {
  const api = getDockApi();
  const doc = getCommandDocument();
  if (api && doc !== document) {
    const group = popoutGroupOfDocument(api, doc);
    if (!group) return; // 子窗已不在
    const panel = group.activePanel;
    if (panel) closePanelOrActiveTab(panel);
    else doc.defaultView?.close();
    return;
  }
  const active = api ? activePanelInDocument(api, document) : undefined;
  if (!active) {
    void coApi.window.close().then((r) => {
      if (!r.ok) notifyFailure(r);
    });
    return;
  }
  closePanelOrActiveTab(active);
}

function closePanelOrActiveTab(active: IDockviewPanel): void {
  if (
    active.view.contentComponent === 'editor' &&
    isEditorGroupId(active.id) &&
    panelActions.get(active.id)?.closeActiveTab()
  ) {
    return;
  }
  active.api.close();
}

/** 触发窗口的编辑器组(commandEditorGroupId)的活动文件 tab(无 → null)。 */
function activeGroupTab(): EditorTab | null {
  const groupId = commandEditorGroupId();
  if (groupId === undefined) return null;
  const s = useEditorStore.getState();
  return findEditorFileTabById(s.tabs, groupActiveTabIdOf(s, groupId));
}

/** 触发窗口的编辑器组内,以活动 tab 为目标做 tab 右键的关闭类动作(无活动 tab / 组面板未挂载 → no-op)。 */
export function closeActiveGroupEditors(kind: TabCloseKind): void {
  const groupId = commandEditorGroupId();
  if (groupId === undefined) return;
  const s = useEditorStore.getState();
  const activeId = groupActiveTabIdOf(s, groupId);
  if (activeId === null) return;
  const ids = tabCloseTargets(groupTabsOf(s, groupId), activeId, kind);
  if (ids.length > 0) panelActions.get(groupId)?.closeTabs(ids);
}

/** 复制活动文件的路径(relative:相对工作区根,同 tab 右键「复制相对路径」)。 */
function copyActiveFilePath(relative: boolean): void {
  const tab = activeGroupTab();
  if (!tab) return;
  const root = useWorkspaceStore.getState().root;
  const text = relative && root !== null ? stripRootPrefix(root, tab.filePath) : tab.filePath;
  void copyToClipboardOrNotify(text, t('panels.explorer.copy_path_failed'));
}

/** 在系统文件管理器中显示活动文件(文件已删除的 orphaned tab 无处可显示 → no-op)。 */
function revealActiveFile(): void {
  const tab = activeGroupTab();
  if (tab && tab.orphaned !== true) void revealPathOrNotify(tab.filePath);
}

/** 在编辑器组(缺省触发窗口的编辑器组)内切到相邻文件 tab(首尾相接);组内 tab 数 < 2 → no-op。 */
export function openAdjacentEditor(delta: 1 | -1, groupId?: string): void {
  const gid = groupId ?? commandEditorGroupId();
  if (gid === undefined) return;
  const s = useEditorStore.getState();
  const tabs = groupTabsOf(s, gid);
  if (tabs.length < 2) return;
  const activeTabId = groupActiveTabIdOf(s, gid);
  const index = activeTabId === null ? -1 : findEditorTabIndexById(tabs, activeTabId);
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index;
  s.switchTab(tabs[(from + delta + tabs.length) % tabs.length]!.id, { groupId: gid });
}

/** 组内关闭类命令(VSCode 同名;tab 右键「关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭」)。 */
const CLOSE_GROUP_EDITORS_COMMANDS: readonly { id: string; kind: TabCloseKind; title: string; titleKey: string }[] = [
  {
    id: 'workbench.action.closeOtherEditors',
    kind: 'others',
    title: 'Close Other Editors in Group',
    titleKey: 'commands.editor.close_others.title',
  },
  {
    id: 'workbench.action.closeEditorsToTheRight',
    kind: 'right',
    title: 'Close Editors to the Right in Group',
    titleKey: 'commands.editor.close_right.title',
  },
  {
    id: 'workbench.action.closeUnmodifiedEditors',
    kind: 'saved',
    title: 'Close Saved Editors in Group',
    titleKey: 'commands.editor.close_saved.title',
  },
  {
    id: 'workbench.action.closeEditorsInGroup',
    kind: 'all',
    title: 'Close All Editors in Group',
    titleKey: 'commands.editor.close_all.title',
  },
];

/** Markdown 编辑 / 源码 / 预览模式(编辑器的模式切换控件同一动作)。 */
const MARKDOWN_MODE_COMMANDS: readonly { id: string; mode: EditorMode; title: string; titleKey: string }[] = [
  { id: 'markdown.switchToEditMode', mode: 'edit', title: 'Switch to Edit Mode', titleKey: 'commands.markdown.edit_mode.title' },
  {
    id: 'markdown.switchToSourceMode',
    mode: 'source',
    title: 'Switch to Source Mode',
    titleKey: 'commands.markdown.source_mode.title',
  },
  {
    id: 'markdown.switchToPreviewMode',
    mode: 'preview',
    title: 'Switch to Preview Mode',
    titleKey: 'commands.markdown.preview_mode.title',
  },
];

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
      ...REOPEN_CLOSED_EDITOR_COMMAND,
      title: 'Reopen Closed Editor',
      titleKey: 'commands.editor.reopen_closed.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => void reopenClosedEditor(),
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
    {
      ...SPLIT_EDITOR_COMMAND,
      title: 'Split Editor',
      titleKey: 'commands.editor.split.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => void splitEditor('right'),
    },
    {
      id: SPLIT_EDITOR_DOWN_COMMAND_ID,
      title: 'Split Editor Down',
      titleKey: 'commands.editor.split_down.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => void splitEditor('down'),
    },
    ...CLOSE_GROUP_EDITORS_COMMANDS.map(
      (c): CommandSpec => ({
        id: c.id,
        title: c.title,
        titleKey: c.titleKey,
        category: 'View',
        categoryKey: 'commands.view.category',
        fn: () => closeActiveGroupEditors(c.kind),
      }),
    ),
    {
      id: 'copyFilePath',
      title: 'Copy Path of Active File',
      titleKey: 'commands.file.copy_path.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: () => copyActiveFilePath(false),
    },
    {
      id: 'copyRelativeFilePath',
      title: 'Copy Relative Path of Active File',
      titleKey: 'commands.file.copy_relative_path.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: () => copyActiveFilePath(true),
    },
    {
      id: 'revealFileInOS',
      title: 'Reveal Active File in Finder',
      titleKey: 'commands.file.reveal.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: revealActiveFile,
    },
    ...MARKDOWN_MODE_COMMANDS.map(
      (c): CommandSpec => ({
        id: c.id,
        title: c.title,
        titleKey: c.titleKey,
        category: 'Markdown',
        categoryKey: 'commands.markdown.category',
        fn: () => {
          const groupId = commandEditorGroupId();
          if (groupId !== undefined) markdownModeActions.get(groupId)?.(c.mode);
        },
      }),
    ),
    ...FOCUS_EDITOR_GROUP_COMMANDS.map(
      (c): CommandSpec => ({
        id: c.id,
        hotkey: c.hotkey,
        title: ['Focus First Editor Group', 'Focus Second Editor Group', 'Focus Third Editor Group'][c.index - 1]!,
        titleKey: `commands.editor.focus_group_${c.index}.title`,
        category: 'View',
        categoryKey: 'commands.view.category',
        fn: () => focusEditorGroup(c.index),
      }),
    ),
  ];
}
