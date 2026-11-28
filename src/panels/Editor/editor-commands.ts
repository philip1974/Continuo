// 工作台编辑器命令(对齐 VSCode 同名命令):
// - workbench.action.closeActiveEditor(⌘W):关当前文件 tab / 其它活动面板,无可关的才关窗口;
// - workbench.action.files.save(⌘S):保存当前活动文件 tab,焦点在哪都生效(无标题文件 → 另存为);
// - workbench.action.files.saveAs(⇧⌘S)/ workbench.action.files.newUntitledFile(⌘N):另存为 / 新建无标题文本文件
//   (BDD: src/__tests__/editor-save-as/);
// - workbench.action.files.revert:还原当前活动文件 tab 为磁盘内容(丢弃未保存修改;同 VSCode 无默认键);
// - workbench.action.files.saveAll(mac ⌥⌘S):保存所有编辑器组里的脏文件 tab,失败处理同 ⌘S;
// - editor.action.toggleWordWrap(⌥Z):切换代码编辑器自动换行(设置 editor.wordWrap,所有编辑器生效);
//   BDD: src/__tests__/workbench-missing-commands/
// - workbench.action.reopenClosedEditor(⇧⌘T):重新打开最近关闭的编辑器(BDD: src/__tests__/editor-reopen-closed/);
// - workbench.action.keepEditor(无默认键):活动预览 tab 转常驻(BDD: src/__tests__/editor-preview-tab/);
// - workbench.action.nextEditor / previousEditor:下一个 / 上一个编辑器(到组尾 / 组首跨到相邻的非空组,首尾相接);
//   nextEditorInGroup / previousEditorInGroup:组内循环(BDD: src/__tests__/editor-tab-management/);
// - 移动编辑器(moveEditorToNext/Previous/First/LastGroup、moveEditorLeft/RightInGroup)、固定(pinEditor / unpinEditor)、
//   按序号打开(openEditorAtIndex1..9 / lastEditorInGroup)、组管理(closeAllEditors / closeAllGroups / closeEditorsAndGroup /
//   joinTwoGroups / joinAllGroups):BDD: src/__tests__/editor-tab-management/;
// - workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup / quickOpenLeastRecentlyUsedEditorInGroup(⌃Tab / ⌃⇧Tab):
//   按组内最近使用顺序切换(BDD: src/__tests__/editor-recent-cycle/);
// - workbench.action.gotoLine(⌃G,各平台同):Quick Open 预填 `:` 转到行 / 列(BDD: src/__tests__/editor-goto-line/);
// - workbench.action.navigateBack / navigateForward(mac ⌃- / ⌃⇧-,Win/Linux Alt+← / Alt+→):后退 / 前进
//   (BDD: src/__tests__/editor-navigation-history/);
// - workbench.action.splitEditor(⌘\)/ splitEditorDown(无默认键)/ focusFirst…EighthEditorGroup(⌘1 … ⌘8):
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
  editorGroupIdsOf,
  editorGroupsOf,
  findEditorTabIndexById,
  getEffectiveMode,
  groupActiveTabIdOf,
  groupStickyTabsOf,
  groupTabMruOf,
  groupTabsOf,
  isTabOpenInOtherGroup,
  isTabSticky,
  useEditorStore,
  type EditorMode,
  type EditorTab,
} from '@/stores/editor.store';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import {
  commandEditorGroupId,
  visibleCommandEditorGroupId,
  editorGroupsInWindow,
  focusEditorGroup,
  joinEditorGroups,
  moveEditor,
  openEditorInGroup,
  splitEditor,
  type MoveEditorTarget,
} from './editor-groups-actions';
import { markEditorGroupCloseApproved } from '@/shell/dock/editor-groups-dock-sync';
import { requestEditorFocus } from './editor-focus-registry';
import type { IDockviewPanel } from 'dockview-react';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { activePanelInDocument, popoutGroupOfDocument } from '@/shell/dock/group-mru';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import { coApi } from '@/lib/co-api';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { revertFile } from './editor-file-actions';
import { isUntitledPath, newUntitledFile } from './untitled';
import { reopenClosedEditor } from './reopen-closed-editor';
import { KEEP_EDITOR_COMMAND_ID, keepActiveEditor } from './editor-preview';
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
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { GOTO_LINE_PREFIX } from '@/plugins/quick-open/goto-line';
import { GOTO_SYMBOL_PREFIX } from '@/plugins/quick-open/use-goto-symbol';
import {
  LEAST_RECENT_EDITOR_IN_GROUP_COMMAND,
  RECENT_EDITOR_IN_GROUP_COMMAND,
  openRecentlyUsedEditorInGroup,
} from './editor-recent-cycle';
import { flushEditorWriteBacks } from './editor-writeback-registry';
import { isImagePreviewPath } from './editor-image';
import { isMarkdownPath } from './editor-path-utils';
import { EDITOR_WORD_WRAP } from '@/plugins/settings/core-setting-specs';
import { getStoredSettingValue, useSettingsValuesStore } from '@/plugins/settings/values-store';
import {
  NAVIGATE_BACK_COMMAND_ID,
  NAVIGATE_FORWARD_COMMAND_ID,
  navigateBack,
  navigateForward,
  navigationCommandHotkeys,
} from './navigation-history';

/** 命令 id 与默认键(终端按生效绑定让出 ⌘W / ⌘S 时与此约定一致)。 */
export const CLOSE_ACTIVE_EDITOR_COMMAND = { id: 'workbench.action.closeActiveEditor', hotkey: 'mod+w' } as const;
export const SAVE_COMMAND = { id: 'workbench.action.files.save', hotkey: 'mod+s' } as const;
/** 另存为(VSCode 同:⇧⌘S / Ctrl+Shift+S)。 */
export const SAVE_AS_COMMAND = { id: 'workbench.action.files.saveAs', hotkey: 'mod+shift+s' } as const;
/** 新建无标题文本文件(VSCode 同:⌘N / Ctrl+N;新建窗口是 ⇧⌘N,见 WindowPlugin)。 */
export const NEW_UNTITLED_FILE_COMMAND = { id: 'workbench.action.files.newUntitledFile', hotkey: 'mod+n' } as const;
export const NEXT_EDITOR_COMMAND_ID = 'workbench.action.nextEditor';
export const PREVIOUS_EDITOR_COMMAND_ID = 'workbench.action.previousEditor';
export const REVERT_COMMAND_ID = 'workbench.action.files.revert';
/**
 * 全部保存(VSCode workbench.action.files.saveAll):mac ⌥⌘S;Windows / Linux 在 VSCode 是组合键 Ctrl+K S,Continuo 不支持
 * 组合键 → 无默认键(可在快捷键设置里绑)。
 */
export const SAVE_ALL_COMMAND_ID = 'workbench.action.files.saveAll';
/** 切换自动换行(VSCode editor.action.toggleWordWrap,各平台 ⌥Z / Alt+Z)。 */
export const TOGGLE_WORD_WRAP_COMMAND = { id: 'editor.action.toggleWordWrap', hotkey: 'alt+z' } as const;
export const SPLIT_EDITOR_COMMAND = { id: 'workbench.action.splitEditor', hotkey: 'mod+\\' } as const;
/** 重新打开已关闭的编辑器(VSCode 同:⇧⌘T / Ctrl+Shift+T;BDD: src/__tests__/editor-reopen-closed/)。 */
export const REOPEN_CLOSED_EDITOR_COMMAND = { id: 'workbench.action.reopenClosedEditor', hotkey: 'mod+shift+t' } as const;
export const SPLIT_EDITOR_DOWN_COMMAND_ID = 'workbench.action.splitEditorDown';
/**
 * 转到行 / 列(VSCode 同:mac ⌃G、Windows / Linux Ctrl+G —— 两平台都是 Control 键,不是 mod)。CodeMirror 自带的 ⌘⌥G 小面板与
 * Win/Linux 上 Ctrl+G = 查找下一个已去掉(见 codemirror-basic-setup;查找下一个为 F3 / 查找框内 Enter,mac 另有 ⌘G)。
 */
export const GOTO_LINE_COMMAND = { id: 'workbench.action.gotoLine', hotkey: 'ctrl+g' } as const;

/** 打开 Quick Open 并预填 `:`(与命令面板互斥,同 ⌘P)。 */
export function openGotoLine(): void {
  useCommandPaletteStore.getState().close();
  useQuickOpenStore.getState().openWith(GOTO_LINE_PREFIX);
}

/**
 * 转到编辑器中的符号(VSCode workbench.action.gotoSymbol:mac ⇧⌘O、Windows / Linux Ctrl+Shift+O)。BDD: src/__tests__/markdown-outline/
 */
export const GOTO_SYMBOL_COMMAND = { id: 'workbench.action.gotoSymbol', hotkey: 'mod+shift+o' } as const;

/** 打开 Quick Open 并预填 `@`(与命令面板互斥,同 ⌘P)。 */
export function openGotoSymbol(): void {
  useCommandPaletteStore.getState().close();
  useQuickOpenStore.getState().openWith(GOTO_SYMBOL_PREFIX);
}
/** 聚焦第 N 个编辑器组(N = 1..8)的命令 id 与默认键(VSCode 同:⌘1 … ⌘8,其它平台 Ctrl+1 …)。 */
export const FOCUS_EDITOR_GROUP_COMMANDS = [
  { id: 'workbench.action.focusFirstEditorGroup', hotkey: 'mod+1', index: 1, title: 'Focus First Editor Group' },
  { id: 'workbench.action.focusSecondEditorGroup', hotkey: 'mod+2', index: 2, title: 'Focus Second Editor Group' },
  { id: 'workbench.action.focusThirdEditorGroup', hotkey: 'mod+3', index: 3, title: 'Focus Third Editor Group' },
  { id: 'workbench.action.focusFourthEditorGroup', hotkey: 'mod+4', index: 4, title: 'Focus Fourth Editor Group' },
  { id: 'workbench.action.focusFifthEditorGroup', hotkey: 'mod+5', index: 5, title: 'Focus Fifth Editor Group' },
  { id: 'workbench.action.focusSixthEditorGroup', hotkey: 'mod+6', index: 6, title: 'Focus Sixth Editor Group' },
  { id: 'workbench.action.focusSeventhEditorGroup', hotkey: 'mod+7', index: 7, title: 'Focus Seventh Editor Group' },
  { id: 'workbench.action.focusEighthEditorGroup', hotkey: 'mod+8', index: 8, title: 'Focus Eighth Editor Group' },
] as const;

/** 组内下一个 / 上一个编辑器(VSCode nextEditorInGroup / previousEditorInGroup:默认键是和弦 ⌘K ⌥⌘→ 等,不支持 → 无默认键)。 */
export const NEXT_EDITOR_IN_GROUP_COMMAND_ID = 'workbench.action.nextEditorInGroup';
export const PREVIOUS_EDITOR_IN_GROUP_COMMAND_ID = 'workbench.action.previousEditorInGroup';
/** 组内最后一个编辑器(VSCode lastEditorInGroup:mac ⌃0,附加 ⌘9;Windows / Linux Alt+0)。 */
export const LAST_EDITOR_IN_GROUP_COMMAND_ID = 'workbench.action.lastEditorInGroup';

/** 按序号打开组内第 N 个编辑器(VSCode openEditorAtIndex1..9:mac ⌃1…⌃9,Windows / Linux Alt+1…Alt+9;9 = 第 9 个,不是最后一个)。 */
export function openEditorAtIndexCommands(isMac: boolean): readonly { id: string; hotkey: string; index: number }[] {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `workbench.action.openEditorAtIndex${n}`,
    hotkey: `${isMac ? 'ctrl' : 'alt'}+${n}`,
    index: n,
  }));
}

/**
 * 移动编辑器的命令(VSCode 同 id 与默认键):移到上一组 / 下一组 mac ⌃⌘← / ⌃⌘→、Windows / Linux Ctrl+Alt+← / Ctrl+Alt+→;移到第一组 /
 * 最后一组 mac ⌃⌘1 / ⌃⌘9、Windows / Linux Shift+Alt+1 / Shift+Alt+9;组内左移 / 右移 Windows / Linux Ctrl+Shift+PageUp / PageDown,mac
 * 是和弦 ⌘K ⇧⌘← / ⌘K ⇧⌘→(不支持 → 无默认键)。
 */
export function moveEditorCommands(
  isMac: boolean,
): readonly { id: string; to: MoveEditorTarget; title: string; titleKey: string; hotkey?: string }[] {
  return [
    {
      id: 'workbench.action.moveEditorToPreviousGroup',
      to: 'previous',
      title: 'Move Editor into Previous Group',
      titleKey: 'commands.editor.move_previous_group.title',
      hotkey: isMac ? 'ctrl+mod+left' : 'ctrl+alt+left',
    },
    {
      id: 'workbench.action.moveEditorToNextGroup',
      to: 'next',
      title: 'Move Editor into Next Group',
      titleKey: 'commands.editor.move_next_group.title',
      hotkey: isMac ? 'ctrl+mod+right' : 'ctrl+alt+right',
    },
    {
      id: 'workbench.action.moveEditorToFirstGroup',
      to: 'first',
      title: 'Move Editor into First Group',
      titleKey: 'commands.editor.move_first_group.title',
      hotkey: isMac ? 'ctrl+mod+1' : 'shift+alt+1',
    },
    {
      id: 'workbench.action.moveEditorToLastGroup',
      to: 'last',
      title: 'Move Editor into Last Group',
      titleKey: 'commands.editor.move_last_group.title',
      hotkey: isMac ? 'ctrl+mod+9' : 'shift+alt+9',
    },
    {
      id: 'workbench.action.moveEditorLeftInGroup',
      to: 'left',
      title: 'Move Editor Left',
      titleKey: 'commands.editor.move_left.title',
      ...(isMac ? {} : { hotkey: 'ctrl+shift+pageup' }),
    },
    {
      id: 'workbench.action.moveEditorRightInGroup',
      to: 'right',
      title: 'Move Editor Right',
      titleKey: 'commands.editor.move_right.title',
      ...(isMac ? {} : { hotkey: 'ctrl+shift+pagedown' }),
    },
  ];
}

/** 固定 / 取消固定编辑器(VSCode pinEditor / unpinEditor:默认键是和弦 ⌘K ⇧Enter,不支持 → 无默认键)。 */
export const PIN_EDITOR_COMMAND_ID = 'workbench.action.pinEditor';
export const UNPIN_EDITOR_COMMAND_ID = 'workbench.action.unpinEditor';

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
  /** 另存为当前活动 tab(无活动 tab → 无操作)。 */
  readonly saveAs: () => Promise<void>;
  /** 按 tab × 同一路径关闭当前活动 tab;无活动 tab → false。 */
  readonly closeActiveTab: () => boolean;
  /** 按 tab 右键「关闭其他 / 右侧 / 已保存 / 全部」同一路径关闭这些 tab(脏 tab 弹确认)。 */
  readonly closeTabs: (ids: readonly string[]) => void;
  /**
   * 关闭编辑器组 / 全部关闭前确认将随之关闭的文档 ids(脏的:保存 / 不保存 / 取消,多个合并一个框);true = 可以关闭
   *(已保存或选了不保存),false = 取消 / 保存失败。
   */
  readonly confirmCloseDocs: (ids: readonly string[]) => Promise<boolean>;
  /**
   * 全部保存的单个 tab:失败处理同显式保存(磁盘已被外部修改 / 写保护 → 覆盖确认;其它 → 按 code 提示)。
   * allowPrompt = false(这次全部保存已弹过一个确认框)→ 确认类失败也只提示,不再弹框。返回是否弹了确认框。
   */
  readonly saveTabForSaveAll: (tabId: string, allowPrompt: boolean) => Promise<boolean>;
  /** 还原会丢掉未保存修改且无法撤销(见 revertLeavesMilkdown)时的确认框;true = 继续还原。 */
  readonly confirmRevertLosingUndo: (tab: EditorTab) => Promise<boolean>;
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

/**
 * 切换预览(VSCode markdown.togglePreview,⇧⌘V / Ctrl+Shift+V,when: Markdown 编辑器获焦):活动 Markdown tab 不在预览 → 切到预览,
 * 并记下原模式;在预览 → 回到原模式(未记过 → 源码,VSCode 预览回到文本编辑器)。切换后焦点进入新视图(再按一次即切回)。
 * BDD: src/__tests__/workbench-vscode-default-keys/
 */
export const MARKDOWN_TOGGLE_PREVIEW_COMMAND = { id: 'markdown.togglePreview', hotkey: 'mod+shift+v' } as const;
let modeBeforePreview: EditorMode = 'source';

function toggleMarkdownPreview(): void {
  const groupId = commandEditorGroupId();
  const action = groupId === undefined ? undefined : markdownModeActions.get(groupId);
  const tab = activeGroupTab();
  if (!action || !tab || !isMarkdownPath(tab.filePath)) return;
  const current = getEffectiveMode(tab);
  if (current === 'preview') action(modeBeforePreview);
  else {
    modeBeforePreview = current;
    action('preview');
  }
  requestEditorFocus(tab.id, groupId);
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

/** 另存为活动编辑器组的活动文件 tab(编辑器面板未挂载 → no-op)。 */
export async function saveActiveEditorAs(): Promise<void> {
  await activeGroupActions()?.saveAs();
}

/**
 * 全部保存(VSCode saveAll):所有编辑器组里的脏文件 tab 逐个保存(先把编辑器里尚未上抛的输入写回 store;图片 tab 只读不算)。
 * 每个 tab 交给它所在编辑器组的面板(覆盖确认框在那个面板里);一次全部保存最多弹一个确认框,其余确认类失败只提示。
 * 有内容的无标题文件逐个弹另存为对话框(VSCode 同);已删除的文件按 ⌘S 同一约定重建。
 */
export async function saveAllEditors(): Promise<void> {
  flushEditorWriteBacks(useEditorStore.getState().tabs.map((t) => t.id));
  const dirty = useEditorStore.getState().tabs.filter((t) => t.dirty && !isImagePreviewPath(t.filePath));
  let prompted = false;
  for (const tab of dirty) {
    const s = useEditorStore.getState();
    const groupId = editorGroupIdsOf(s).find((g) => groupTabsOf(s, g).some((t) => t.id === tab.id));
    const actions = (groupId !== undefined ? panelActions.get(groupId) : undefined) ?? panelActions.values().next().value;
    if (!actions) return;
    if (await actions.saveTabForSaveAll(tab.id, !prompted)) prompted = true;
  }
}

/** 切换自动换行:翻转设置 editor.wordWrap(所有代码编辑器随之 reconfigure;设置页同一开关)。 */
export function toggleWordWrap(): void {
  const on = (getStoredSettingValue(EDITOR_WORD_WRAP.id) ?? EDITOR_WORD_WRAP.default) === true;
  useSettingsValuesStore.getState().setValue(EDITOR_WORD_WRAP.id, !on);
}

/**
 * 还原触发窗口的编辑器组的活动文件 tab 为磁盘内容(无活动 tab → no-op;读盘失败按 code 提示,tab 不变)。还原可撤销;唯一
 * 不可撤销的情况(脏、且磁盘版本只能以源码模式显示)先经该组面板确认(破坏性,初始焦点在取消)。
 */
export async function revertActiveEditor(): Promise<void> {
  const tab = activeGroupTab();
  if (!tab) return;
  const actions = activeGroupActions();
  const r = await revertFile(tab.id, editorFileDeps, actions ? { confirmLosingUndo: actions.confirmRevertLosingUndo } : undefined);
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
export function activeGroupTab(): EditorTab | null {
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
  const ids = tabCloseTargets(closeItemsOfGroup(groupId), activeId, kind);
  if (ids.length > 0) panelActions.get(groupId)?.closeTabs(ids);
}

/** 组内 tab 的关闭类目标项(带脏 / 固定:「关闭其他 / 右侧 / 已保存 / 全部」跳过固定的,VSCode excludeSticky)。 */
function closeItemsOfGroup(groupId: string): { id: string; dirty: boolean; sticky: boolean }[] {
  const s = useEditorStore.getState();
  const sticky = groupStickyTabsOf(s, groupId);
  return groupTabsOf(s, groupId).map((t) => ({ id: t.id, dirty: t.dirty, sticky: sticky.includes(t.id) }));
}

/**
 * ⌘W / 菜单「关闭编辑器」遇固定的活动 tab:不关闭,改打开组内最近使用的非固定编辑器;组内没有 → 按组的最近使用顺序在别的组里找;
 * 都没有 → 不动(VSCode closeEditorHandler,preventPinnedEditorClose 默认 keyboardAndMouse)。
 */
export function revealNextNonStickyEditor(groupId: string): void {
  const s = useEditorStore.getState();
  const order = [groupId, ...s.groupMru.filter((id) => id !== groupId), ...editorGroupIdsOf(s)];
  for (const gid of new Set(order)) {
    const ids = groupTabsOf(s, gid).map((t) => t.id);
    const candidates = [...(groupTabMruOf(s, gid) ?? []), ...ids];
    const next = candidates.find((id) => ids.includes(id) && !isTabSticky(s, gid, id));
    if (next !== undefined) {
      openEditorInGroup(gid, next);
      return;
    }
  }
}

/** 已登记的编辑器组面板动作(未挂载 → undefined)。 */
function panelActionsOf(groupId: string): EditorPanelActions | undefined {
  return panelActions.get(groupId);
}

/** 组里只在本组打开的文档(关掉本组即随之关闭的)。 */
function exclusiveDocsOf(groupId: string): string[] {
  const s = useEditorStore.getState();
  return groupTabsOf(s, groupId)
    .map((t) => t.id)
    .filter((id) => !isTabOpenInOtherGroup(s, id, groupId));
}

/**
 * 编辑器组 dock 面板的关闭守卫(dock tab × / 中键 / 面板菜单关闭 / ⌘W 关空组等所有 api.close 入口):多个组时,只在本组打开的文档里
 * 有脏的 → 经本组面板确认(保存 / 不保存 / 取消,多个合并一个框;VSCode 关闭含脏编辑器的组逐个确认,这里按用户选定合并);确认通过 →
 * 面板移除时这些文档全部关闭(「不保存」的可在重新打开后 ⌘Z 找回);取消 / 保存失败 → 组不关。唯一的组(文档保留)、组已不在 store
 *(组随最后一个 tab 关闭后关面板)、没有脏文档 → 直接放行。BDD: src/__tests__/editor-groups/(close-dirty-group)
 */
export function editorGroupCloseGuard(groupId: string): boolean | Promise<boolean> {
  const s = useEditorStore.getState();
  if (!editorGroupIdsOf(s).includes(groupId) || editorGroupIdsOf(s).length < 2) return true;
  const ids = exclusiveDocsOf(groupId);
  flushEditorWriteBacks(ids);
  const tabs = useEditorStore.getState().tabs;
  const anyDirty = ids.some((id) => tabs.some((t) => t.id === id && t.dirty && !isImagePreviewPath(t.filePath)));
  const actions = panelActionsOf(groupId);
  if (!anyDirty || !actions) return true;
  return actions.confirmCloseDocs(ids).then((ok) => {
    if (ok) markEditorGroupCloseApproved(groupId);
    return ok;
  });
}

/**
 * 关闭编辑器组(VSCode workbench.action.closeEditorsAndGroup,命令面板「关闭编辑器组」):关闭组内全部编辑器(含固定的),组变空后关闭;
 * 只在本组打开的脏文档先确认(同 dock tab ×);取消 → 不动。唯一的组 → 只关闭其编辑器(组保留,同 VSCode)。
 */
export async function closeEditorGroup(groupId: string | undefined = commandEditorGroupId()): Promise<void> {
  if (groupId === undefined) return;
  const ids = groupTabsOf(useEditorStore.getState(), groupId).map((t) => t.id);
  if (ids.length === 0) {
    // 空组:直接关它的面板(多个组时;唯一的空组保留)
    if (editorGroupIdsOf(useEditorStore.getState()).length > 1) getDockApi()?.getPanel(groupId)?.api.close();
    return;
  }
  const actions = panelActionsOf(groupId);
  if (actions && !(await actions.confirmCloseDocs(exclusiveDocsOf(groupId)))) return;
  closeEditorsConfirmed([{ groupId, ids }]);
}

/**
 * 全部关闭(VSCode closeAllEditors:各组里除固定外的编辑器;closeAllGroups:全部编辑器含固定的,随后空组关闭):随之关闭的脏文档
 * 合并成一个确认框(VSCode AbstractCloseAllAction 跨组只问一次),取消 → 都不关。确认框在触发窗口的编辑器组面板里。
 */
export async function closeAllEditors(includeSticky: boolean): Promise<void> {
  const s = useEditorStore.getState();
  const plan = editorGroupsOf(s).map((g) => {
    const sticky = includeSticky ? [] : groupStickyTabsOf(s, g.id);
    return { groupId: g.id, ids: g.tabIds.filter((id) => !sticky.includes(id)) };
  });
  // 随之关闭的文档:它所在的每个组都要关掉它(在某组固定的仍留着)
  const remaining = new Set<string>();
  for (const g of editorGroupsOf(s)) {
    const closingHere = plan.find((p) => p.groupId === g.id)?.ids ?? [];
    for (const id of g.tabIds) if (!closingHere.includes(id)) remaining.add(id);
  }
  const closing = [...new Set(plan.flatMap((p) => p.ids))].filter((id) => !remaining.has(id));
  if (closing.length === 0) return;
  const gid = commandEditorGroupId();
  const actions = (gid === undefined ? undefined : panelActionsOf(gid)) ?? panelActions.values().next().value;
  if (actions && !(await actions.confirmCloseDocs(closing))) return;
  closeEditorsConfirmed(plan);
}

/** 已确认后按组关闭(逐个 closeTab:入最近关闭栈、「不保存」的留撤销历史);之后焦点交给活动组的编辑器。 */
function closeEditorsConfirmed(plan: readonly { readonly groupId: string; readonly ids: readonly string[] }[]): void {
  for (const { groupId, ids } of plan) {
    for (const id of ids) useEditorStore.getState().closeTab(id, groupId);
  }
  const s = useEditorStore.getState();
  const active = groupActiveTabIdOf(s, s.activeGroupId);
  if (active !== null) requestEditorFocus(active, s.activeGroupId);
}

/** 复制活动文件的路径(relative:相对工作区根,同 tab 右键「复制相对路径」)。 */
function copyActiveFilePath(relative: boolean): void {
  const tab = activeGroupTab();
  if (!tab || isUntitledPath(tab.filePath)) return; // 无标题文件没有路径
  const root = useWorkspaceStore.getState().root;
  const text = relative && root !== null ? stripRootPrefix(root, tab.filePath) : tab.filePath;
  void copyToClipboardOrNotify(text, t('panels.explorer.copy_path_failed'));
}

/** 在系统文件管理器中显示活动文件(文件已删除的 orphaned tab 无处可显示 → no-op)。 */
function revealActiveFile(): void {
  const tab = activeGroupTab();
  if (tab && tab.orphaned !== true && !isUntitledPath(tab.filePath)) void revealPathOrNotify(tab.filePath);
}

/**
 * 在编辑器组(缺省触发窗口的编辑器组)内切到相邻文件 tab(首尾相接)并聚焦它的编辑器(VSCode nextEditorInGroup / previousEditorInGroup;
 * 打开时不带 preserveFocus,焦点随之进编辑器);组内 tab 数 < 2 → no-op。
 */
export function openAdjacentEditorInGroup(delta: 1 | -1, groupId?: string): void {
  const gid = groupId ?? visibleCommandEditorGroupId();
  if (gid === undefined) return;
  const s = useEditorStore.getState();
  const tabs = groupTabsOf(s, gid);
  if (tabs.length < 2) return;
  const activeTabId = groupActiveTabIdOf(s, gid);
  const index = activeTabId === null ? -1 : findEditorTabIndexById(tabs, activeTabId);
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index;
  const next = tabs[(from + delta + tabs.length) % tabs.length]!.id;
  s.switchTab(next, { groupId: gid });
  requestEditorFocus(next, gid);
}

/**
 * 下一个 / 上一个编辑器(VSCode nextEditor / previousEditor):组内切到相邻 tab;已在组尾(组首)→ 所在窗口按空间顺序的下一个(上一个)
 * 非空组的第一个(最后一个)编辑器,首尾相接(只有一个非空组时即组内循环)。焦点随之进编辑器。
 */
export function openAdjacentEditor(delta: 1 | -1, groupId?: string): void {
  const gid = groupId ?? visibleCommandEditorGroupId();
  if (gid === undefined) return;
  const s = useEditorStore.getState();
  const tabs = groupTabsOf(s, gid);
  const activeTabId = groupActiveTabIdOf(s, gid);
  const index = activeTabId === null ? -1 : findEditorTabIndexById(tabs, activeTabId);
  const inGroup = index < 0 ? (delta > 0 ? 0 : tabs.length - 1) : index + delta;
  const nextInGroup = tabs[inGroup];
  if (nextInGroup) {
    s.switchTab(nextInGroup.id, { groupId: gid });
    requestEditorFocus(nextInGroup.id, gid);
    return;
  }
  const order = editorGroupsInWindow(gid);
  const at = order.indexOf(gid);
  for (let step = 1; step <= order.length; step++) {
    const target = order[(((at + delta * step) % order.length) + order.length) % order.length]!;
    const targetTabs = groupTabsOf(s, target);
    if (targetTabs.length === 0) continue;
    const next = targetTabs[delta > 0 ? 0 : targetTabs.length - 1]!.id;
    if (target === gid && next === activeTabId) return;
    openEditorInGroup(target, next);
    return;
  }
}

/** 按序号打开触发窗口的编辑器组里第 n 个(1 起)编辑器;n = Infinity → 最后一个。不存在 → no-op。 */
export function openEditorAtIndex(n: number): void {
  const gid = visibleCommandEditorGroupId();
  if (gid === undefined) return;
  const tabs = groupTabsOf(useEditorStore.getState(), gid);
  const tab = n === Infinity ? tabs.at(-1) : tabs[n - 1];
  if (tab) openEditorInGroup(gid, tab.id);
}

/** 固定 / 取消固定触发窗口的编辑器组的活动编辑器。 */
function setActiveEditorSticky(sticky: boolean): void {
  const gid = commandEditorGroupId();
  if (gid === undefined) return;
  const s = useEditorStore.getState();
  const id = groupActiveTabIdOf(s, gid);
  if (id === null) return;
  if (sticky) s.pinEditor(id, gid);
  else s.unpinEditor(id, gid);
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
  const navigationKeys = navigationCommandHotkeys(isMac);
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
      ...SAVE_AS_COMMAND,
      title: 'Save As…',
      titleKey: 'commands.file.save_as.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: saveActiveEditorAs,
    },
    {
      ...NEW_UNTITLED_FILE_COMMAND,
      title: 'New Untitled Text File',
      titleKey: 'commands.file.new_untitled.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: () => void newUntitledFile(commandEditorGroupId()),
    },
    {
      id: SAVE_ALL_COMMAND_ID,
      title: 'Save All',
      titleKey: 'commands.file.save_all.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      ...(isMac ? { hotkey: 'mod+alt+s' } : {}),
      fn: saveAllEditors,
    },
    {
      ...TOGGLE_WORD_WRAP_COMMAND,
      title: 'Toggle Word Wrap',
      titleKey: 'commands.editor.toggle_word_wrap.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: toggleWordWrap,
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
      // VSCode 默认键 ⌘K Enter 是组合键,Continuo 不支持 → 无默认键(BDD: src/__tests__/editor-preview-tab/)
      id: KEEP_EDITOR_COMMAND_ID,
      title: 'Keep Editor',
      titleKey: 'commands.editor.keep.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: keepActiveEditor,
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
      // VSCode mac 附加默认键 ⇧⌘](Windows / Linux 无)
      ...(isMac ? { secondaryHotkeys: ['mod+shift+]'] } : {}),
      fn: () => openAdjacentEditor(1),
    },
    {
      id: PREVIOUS_EDITOR_COMMAND_ID,
      title: 'Open Previous Editor',
      titleKey: 'commands.editor.previous.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      hotkey: isMac ? 'mod+alt+left' : 'ctrl+pageup',
      // VSCode mac 附加默认键 ⇧⌘[(Windows / Linux 无)
      ...(isMac ? { secondaryHotkeys: ['mod+shift+['] } : {}),
      fn: () => openAdjacentEditor(-1),
    },
    {
      ...RECENT_EDITOR_IN_GROUP_COMMAND,
      title: 'Open Previous Recently Used Editor in Group',
      titleKey: 'commands.editor.recent_in_group.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => openRecentlyUsedEditorInGroup(1),
    },
    {
      ...LEAST_RECENT_EDITOR_IN_GROUP_COMMAND,
      title: 'Open Least Recently Used Editor in Group',
      titleKey: 'commands.editor.least_recent_in_group.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => openRecentlyUsedEditorInGroup(-1),
    },
    {
      ...GOTO_LINE_COMMAND,
      title: 'Go to Line/Column…',
      titleKey: 'commands.editor.goto_line.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: openGotoLine,
    },
    {
      ...GOTO_SYMBOL_COMMAND,
      title: 'Go to Symbol in Editor…',
      titleKey: 'commands.editor.goto_symbol.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: openGotoSymbol,
    },
    {
      id: NAVIGATE_BACK_COMMAND_ID,
      title: 'Go Back',
      titleKey: 'commands.editor.navigate_back.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      hotkey: navigationKeys.back,
      fn: () => void navigateBack(),
    },
    {
      id: NAVIGATE_FORWARD_COMMAND_ID,
      title: 'Go Forward',
      titleKey: 'commands.editor.navigate_forward.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      hotkey: navigationKeys.forward,
      fn: () => void navigateForward(),
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
    {
      ...MARKDOWN_TOGGLE_PREVIEW_COMMAND,
      title: 'Toggle Preview',
      titleKey: 'commands.markdown.toggle_preview.title',
      category: 'Markdown',
      categoryKey: 'commands.markdown.category',
      when: 'markdownEditorFocus',
      fn: toggleMarkdownPreview,
    },
    ...FOCUS_EDITOR_GROUP_COMMANDS.map(
      (c): CommandSpec => ({
        id: c.id,
        hotkey: c.hotkey,
        title: c.title,
        titleKey: `commands.editor.focus_group_${c.index}.title`,
        category: 'View',
        categoryKey: 'commands.view.category',
        fn: () => focusEditorGroup(c.index),
      }),
    ),
    {
      id: NEXT_EDITOR_IN_GROUP_COMMAND_ID,
      title: 'Open Next Editor in Group',
      titleKey: 'commands.editor.next_in_group.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => openAdjacentEditorInGroup(1),
    },
    {
      id: PREVIOUS_EDITOR_IN_GROUP_COMMAND_ID,
      title: 'Open Previous Editor in Group',
      titleKey: 'commands.editor.previous_in_group.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => openAdjacentEditorInGroup(-1),
    },
    ...openEditorAtIndexCommands(isMac).map(
      (c): CommandSpec => ({
        id: c.id,
        hotkey: c.hotkey,
        title: `Open Editor at Index ${c.index}`,
        titleKey: `commands.editor.open_at_index_${c.index}.title`,
        category: 'View',
        categoryKey: 'commands.view.category',
        fn: () => openEditorAtIndex(c.index),
      }),
    ),
    {
      id: LAST_EDITOR_IN_GROUP_COMMAND_ID,
      title: 'Open Last Editor in Group',
      titleKey: 'commands.editor.last_in_group.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      hotkey: isMac ? 'ctrl+0' : 'alt+0',
      ...(isMac ? { secondaryHotkeys: ['mod+9'] } : {}),
      fn: () => openEditorAtIndex(Infinity),
    },
    ...moveEditorCommands(isMac).map(
      (c): CommandSpec => ({
        id: c.id,
        ...(c.hotkey === undefined ? {} : { hotkey: c.hotkey }),
        title: c.title,
        titleKey: c.titleKey,
        category: 'View',
        categoryKey: 'commands.view.category',
        fn: () => void moveEditor(c.to),
      }),
    ),
    {
      id: PIN_EDITOR_COMMAND_ID,
      title: 'Pin Editor',
      titleKey: 'commands.editor.pin.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => setActiveEditorSticky(true),
    },
    {
      id: UNPIN_EDITOR_COMMAND_ID,
      title: 'Unpin Editor',
      titleKey: 'commands.editor.unpin.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => setActiveEditorSticky(false),
    },
    {
      // VSCode 默认键 ⌘K ⌘W 是和弦,不支持 → 无默认键;closeAllGroups(⌘K ⇧⌘W)同
      id: 'workbench.action.closeAllEditors',
      title: 'Close All Editors',
      titleKey: 'commands.editor.close_all_editors.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => void closeAllEditors(false),
    },
    {
      id: 'workbench.action.closeAllGroups',
      title: 'Close All Editor Groups',
      titleKey: 'commands.editor.close_all_groups.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => void closeAllEditors(true),
    },
    {
      id: 'workbench.action.closeEditorsAndGroup',
      title: 'Close Editor Group',
      titleKey: 'commands.editor.close_group.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => void closeEditorGroup(),
    },
    {
      id: 'workbench.action.joinTwoGroups',
      title: 'Join Editor Group with Next Group',
      titleKey: 'commands.editor.join_two_groups.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => joinEditorGroups(false),
    },
    {
      id: 'workbench.action.joinAllGroups',
      title: 'Join All Editor Groups',
      titleKey: 'commands.editor.join_all_groups.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => joinEditorGroups(true),
    },
  ];
}
