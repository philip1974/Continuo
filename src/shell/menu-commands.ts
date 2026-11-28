// 应用菜单项即 renderer 命令(MENU_COMMAND_IDS,如 文件 → 打开文件夹… ⌘O):main 发 RUN_MENU_COMMAND,这里经命令注册表执行;
// 反向把菜单命令当前生效的主键推给 main(菜单 accelerator 跟随改键 / 解绑 / 冲突落败)。
// BDD: src/__tests__/explorer-commands/(第 5 条)、src/__tests__/app-menu-bar/

import { useEffect, useMemo } from 'react';
import { redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { coApi } from '@/lib/co-api';
import { tWithFallback } from '@/i18n';
import { hasOpenModalIn } from '@/design/Modal';
import { isInsideMenu } from '@/lib/menu-focus';
import { whenHoldsInDocument } from '@/lib/editor-text-focus';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import type { CommandRegistry, CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { resolveDisplayHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { isHotkeyShadowed } from '@/plugins/command-palette/useCommandHotkeys';
import { canonicalHotkey, detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import { getPopoutDocuments, runInCommandDocument } from '@/shell/dock/popout-documents';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  FILES_AUTO_SAVE,
  WORKBENCH_EDITOR_SHOW_TABS,
  type EditorShowTabs,
  type FilesAutoSaveMode,
} from '@/plugins/settings/core-setting-specs';
import { useActivityBarVisible, useStatusBarVisible } from './workbench-layout';
import { isExplorerTreeFocused } from '@/panels/Explorer/tree-keyboard';
import { requestExplorer } from '@/panels/Explorer/explorer-requests';
import { useWorkspaceStore } from '@/stores/workspace.store';
import {
  isEditUndoRedoPayload,
  isMenuCommandPayload,
  MENU_COMMAND_IDS,
  type MenuCheckboxId,
  type MenuCommandId,
} from '../../electron/shared/window-channels';

/** 菜单触发的命令作用于哪个窗口的文档:获焦的 popout 子窗(只有一个子窗时即它),否则主窗。 */
function menuCommandDocument(fromPopout: boolean): Document {
  if (!fromPopout) return document;
  const popouts = getPopoutDocuments();
  return popouts.find((doc) => doc.hasFocus()) ?? (popouts.length === 1 ? popouts[0]! : document);
}

/**
 * 只认登记过的菜单命令;任一文档(主窗 / popout 子窗)有 Modal 打开、或焦点在打开的菜单里时不执行(与工作台快捷键一致,
 * 对齐 VSCode)。命令作用于获焦的窗口(与热键分发同一机制 runInCommandDocument:popout 子窗获焦 → 该子窗)。
 * accelerator 触发(viaKey:按键已先经 renderer 分发而未被处理)→ 按命令的上下文条件重新判定,不成立不执行(终端里按 ⌘/
 * 不去注释编辑器);点击菜单项不受上下文条件限制,与命令面板一致(编辑器命令作用于该窗口的活动文本编辑器,没有则静默)。
 * 选择器类命令(转到文件 / 转到行 / 命令面板 / 打开最近)画在该窗口;在主窗打开面板的命令(⌘, / ⇧⌘F…)从子窗触发时激活主窗
 *(BDD: src/__tests__/popout-picker/)。
 */
export function runMenuCommand(commands: CommandRegistry, payload: unknown): void {
  if (!isMenuCommandPayload(payload)) return;
  const blocked = (doc: Document) => hasOpenModalIn(doc) || isInsideMenu(doc.activeElement);
  if (blocked(document) || getPopoutDocuments().some(blocked)) return;
  const spec = commands.get(payload.id);
  const doc = menuCommandDocument(payload.fromPopout);
  if (payload.viaKey && !whenHoldsInDocument(spec?.when, doc)) return;
  const label = spec ? tWithFallback(spec.titleKey, spec.title) : payload.id;
  void runInCommandDocument(doc, () => runRegisteredCommand(commands, payload.id, label));
}

/**
 * 焦点在编辑器正文里 → 用编辑器自己的撤销栈撤销 / 重做,返回 true(VSCode CoreEditingCommands.Undo / Redo 的 runEditorCommand:
 * 编辑器聚焦 → editor.getModel().undo() / redo(),不走 document.execCommand)。Chromium 原生撤销栈只记它见过的输入:命令产生的修改
 *(切换注释 / 缩进 / 替换 / 还原)、重做都不在其中,栈空时不派发 historyUndo / historyRedo,菜单点了没反应。
 * - Milkdown(ProseMirror 正文,含其代码块里的 CodeMirror)→ 在 ProseMirror 根上派发 beforeinput historyUndo / historyRedo,由
 *   prosemirror-history 自己的处理器执行(与 Chromium 原生撤销到达 ProseMirror 的同一入口;只读时它不处理)
 * - CodeMirror 正文(代码编辑器 / Markdown 源码 / 差异视图…)→ @codemirror/commands 的 undo / redo(只读时它们不改)
 * 输入框 / 文本域(含编辑器内的查找框)、终端等 → false,照旧原生(VSCode runDOMCommand)。
 */
function runFocusedEditorUndoRedo(doc: Document, op: 'undo' | 'redo'): boolean {
  const active = doc.activeElement;
  if (!active || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') return false;
  const pm = active.closest('.ProseMirror');
  if (pm) {
    const InputEventCtor = doc.defaultView?.InputEvent ?? InputEvent;
    const inputType = op === 'undo' ? 'historyUndo' : 'historyRedo';
    pm.dispatchEvent(new InputEventCtor('beforeinput', { inputType, bubbles: true, cancelable: true }));
    return true;
  }
  const root = active.closest('.cm-editor');
  const view = root ? EditorView.findFromDOM(root as HTMLElement) : null;
  if (!view || !view.contentDOM.contains(active)) return false;
  (op === 'undo' ? undo : redo)(view);
  return true;
}

/**
 * 应用菜单「编辑 → 撤销 / 重做」被点(VSCode UndoCommand / RedoCommand 多实现,资源管理器实现优先):获焦窗口(popout 子窗获焦 →
 * 该子窗)的文件树聚焦(且没有 Modal)→ 撤销 / 重做文件操作(同树内 ⌘Z);编辑器正文聚焦 → 编辑器自己的撤销栈(同 ⌘Z / ⇧⌘Z,见
 * runFocusedEditorUndoRedo);否则请 main 对该窗口做原生撤销 / 重做(输入框 / 终端 / Modal 里照旧)。BDD: src/__tests__/app-menu-bar/
 */
export function runEditUndoRedo(payload: unknown): void {
  if (!isEditUndoRedoPayload(payload)) return;
  const doc = menuCommandDocument(payload.fromPopout);
  if (!hasOpenModalIn(doc) && isExplorerTreeFocused(doc) && useWorkspaceStore.getState().root) {
    requestExplorer({ kind: payload.op });
    return;
  }
  if (!hasOpenModalIn(doc) && runFocusedEditorUndoRedo(doc, payload.op)) return;
  const popout = doc === document ? null : doc.defaultView;
  // 原生撤销失败(窗口已关等)无可提示的内容
  void Promise.resolve()
    .then(() =>
      popout ? coApi.window.viewAction(payload.op, { popoutName: popout.name }) : coApi.window.viewAction(payload.op),
    )
    .catch(() => undefined);
}

/**
 * 显示另一命令键位的菜单项:「设置…」(workbench.action.openSettings,只打开)显示 ⌘,(settings.toggle 的键位;VSCode 菜单「设置」
 * 显示 ⌘,)。设置未显示时两者效果相同;⌘, 在设置已显示时收回设置(本项目约定,见 settings-toggle)。
 */
const MENU_ACCELERATOR_FROM: Partial<Record<MenuCommandId, string>> = {
  'workbench.action.openSettings': 'settings.toggle',
};

/**
 * 菜单命令当前显示的主键(归一后的 hotkey,见 canonicalHotkey):与命令面板 / tooltip 同一规则(resolveDisplayHotkey:改键跟随、
 * 解绑 / 落在保留键上不显示,转到文件… / 显示所有命令显示其保留键),冲突落败(按下执行别的命令)不显示。未注册 → null。
 */
export function menuKeybindings(
  commands: Pick<CommandRegistry, 'get'>,
  all: readonly CommandSpec[],
  overrides: Readonly<Record<string, string>>,
  platform: Platform,
): Record<MenuCommandId, string | null> {
  const out = {} as Record<MenuCommandId, string | null>;
  for (const id of MENU_COMMAND_IDS) {
    const keyId = MENU_ACCELERATOR_FROM[id] ?? id;
    const spec = commands.get(keyId);
    const combo = spec && !isHotkeyShadowed(keyId, all, platform, overrides) ? resolveDisplayHotkey(spec, overrides, platform) : undefined;
    out[id] = combo ? canonicalHotkey(combo, platform) : null;
  }
  return out;
}

/** 勾选类菜单项的勾选状态:文件 → 自动保存 = files.autoSave ≠ off(VSCode toggled: config.files.autoSave != off)。 */
export function menuCheckedState(autoSave: FilesAutoSaveMode): Partial<Record<MenuCheckboxId, boolean>> {
  return { 'workbench.action.toggleAutoSave': autoSave !== 'off' };
}

/**
 * 显示 › 外观的勾选状态(VSCode toggled:config.workbench.statusBar.visible、activityBar.location ≠ hidden、
 * config.workbench.editor.showTabs == multiple / none)。BDD: src/__tests__/workbench-layout-visibility/
 */
export function layoutMenuCheckedState(
  statusBarVisible: boolean,
  activityBarVisible: boolean,
  showTabs: EditorShowTabs,
): Partial<Record<MenuCheckboxId, boolean>> {
  return {
    'workbench.action.toggleStatusbarVisibility': statusBarVisible,
    'workbench.action.toggleActivityBarVisibility': activityBarVisible,
    'workbench.action.showMultipleEditorTabs': showTabs === 'multiple',
    'workbench.action.hideEditorTabs': showTabs === 'none',
  };
}

export function useMenuCommands(commands: CommandRegistry): void {
  useEffect(() => coApi.window.onMenuCommand((payload) => runMenuCommand(commands, payload)), [commands]);
  useEffect(() => coApi.window.onEditUndoRedo(runEditUndoRedo), []);

  // 命令注册 / 注销、改键 / 解绑后重算;内容不变不重复推送。
  const all = useRegistry(commands);
  const overrides = useKeybindingsStore((s) => s.overrides);
  const platform = useMemo(() => detectPlatform(), []);
  const serialized = useMemo(
    () => JSON.stringify(menuKeybindings(commands, all, overrides, platform)),
    [commands, all, overrides, platform],
  );
  useEffect(() => {
    const keybindings = JSON.parse(serialized) as Record<MenuCommandId, string | null>;
    // 推送失败只影响菜单上的键位显示,不打扰用户
    coApi.window.setMenuKeybindings(keybindings).catch(() => undefined);
  }, [serialized]);

  // 勾选状态随设置变化推送(别的窗口改的设置经跨窗同步到达后同样推送,菜单是全应用共用的一份)。
  const autoSave = useSettingValue(FILES_AUTO_SAVE.id, FILES_AUTO_SAVE.default);
  const statusBarVisible = useStatusBarVisible();
  const activityBarVisible = useActivityBarVisible();
  const showTabs = useSettingValue(WORKBENCH_EDITOR_SHOW_TABS.id, WORKBENCH_EDITOR_SHOW_TABS.default);
  useEffect(() => {
    const checked = { ...menuCheckedState(autoSave), ...layoutMenuCheckedState(statusBarVisible, activityBarVisible, showTabs) };
    // 推送失败只影响菜单勾选显示,不打扰用户(测试替身可能没有该方法:同样吞掉)
    void Promise.resolve()
      .then(() => coApi.window.setMenuChecked(checked))
      .catch(() => undefined);
  }, [autoSave, statusBarVisible, activityBarVisible, showTabs]);
}
